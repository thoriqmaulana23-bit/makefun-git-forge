// GitHub REST v3 surface: repos, branches, commits, contents, labels, issues,
// comments, pull requests. All data lives in lib/store.ts; all replies are
// JSON with a non-empty X-GitHub-Request-Id.
import { EPOCH_SEC, parseCommit, parseTree, store, nowIso, OWNER_EMAIL, OWNER_ID, OWNER_LOGIN, OWNER_NAME, type Issue, type Pull, type Repo } from './store.ts';

export interface RestCtx {
  method: string;
  path: string; // pathname, decoded
  query: URLSearchParams;
  body: unknown;
  base: string; // e.g. http://127.0.0.1:1234
}

export interface RestResult { status: number; body: unknown; headers?: Record<string, string>; bodyText?: string }

let requestSeq = 0;
export function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function userJson(): Record<string, unknown> {
  return {
    login: OWNER_LOGIN, id: OWNER_ID, node_id: globalId('User', OWNER_ID),
    avatar_url: `https://avatars.githubusercontent.com/u/${OWNER_ID}`,
    type: 'User', site_admin: false, name: OWNER_NAME, email: OWNER_EMAIL,
    html_url: `https://github.com/${OWNER_LOGIN}`, url: `/api/v3/users/${OWNER_LOGIN}`,
  };
}

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind: kind as string, parts };
  } catch { return null; }
}

export function repoJson(repo: Repo, base: string): Record<string, unknown> {
  return {
    id: repo.id, node_id: globalId('Repository', repo.id),
    name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: OWNER_ID, node_id: globalId('User', OWNER_ID), type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/${OWNER_ID}` },
    private: repo.private, description: repo.description,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at, updated_at: repo.updated_at, pushed_at: repo.updated_at,
    has_issues: true, has_projects: true, has_wiki: true, has_pages: false,
    forks_count: 0, stargazers_count: 0, watchers_count: 0, open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null, topics: [], visibility: repo.private ? 'private' : 'public',
    archived: false, disabled: false, allow_squash_merge: true,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const l = repo.labels.get(name);
  return {
    id: 1000 + [...repo.labels.keys()].indexOf(name),
    node_id: globalId('Label', repo.id, name),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name, color: l?.color ?? 'ededed', description: l?.description ?? '', default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {  return {
    id: issue.id, node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((n) => labelJson(repo, n)),
    user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' },
    assignees: [], milestone: null, locked: false,
    comments: issue.comments.length,
    created_at: issue.created_at, updated_at: issue.updated_at, closed_at: issue.state === 'closed' ? issue.updated_at : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

// --- cached single-issue JSON (the read workload's hot path) ----------------
// A GET of one issue serializes the same object on every call: the bytes only
// change when the issue itself changes (PATCH, or a comment arriving, which
// changes the comments count) or when `base` (the request host) changes. The
// cache is keyed by the repo object (WeakMap: a deleted repo's entries are
// collected) and by base+number, and is invalidated on exactly those two
// mutations. The cached text is byte-identical to JSON.stringify(issueJson())
// plus the trailing newline sendJson appends, so the response is unchanged.
const issueJsonCache = new WeakMap<Repo, Map<string, string>>();

function cachedIssueJsonText(repo: Repo, issue: Issue, base: string): string {
  const key = `${base}\n${issue.number}`;
  let perRepo = issueJsonCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, string>();
    issueJsonCache.set(repo, perRepo);
  }
  let text = perRepo.get(key);
  if (text === undefined) {
    text = `${JSON.stringify(issueJson(repo, issue, base))}\n`;
    if (perRepo.size >= 1024) perRepo.clear();
    perRepo.set(key, text);
  }
  return text;
}

function invalidateIssueJson(repo: Repo, issue: Issue): void {
  const perRepo = issueJsonCache.get(repo);
  if (perRepo === undefined) return;
  const suffix = `\n${issue.number}`;
  for (const key of [...perRepo.keys()]) if (key.endsWith(suffix)) perRepo.delete(key);
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const date = new Date(info.epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    sha, node_id: globalId('Commit', sha),
    commit: {
      message: info.message,
      author: { name: info.authorName, email: info.authorEmail, date },
      committer: { name: info.authorName, email: info.authorEmail, date },
      tree: { sha: info.tree },
    },
    author: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' },
    committer: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' },
    parents: info.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

export function pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseSha = pull.baseSha;
  const headSha = pull.headSha;
  const mergeBase = baseSha && headSha ? store.mergeBase(repo, headSha, baseSha) : null;
  const fromTree = mergeBase ? treeOf(repo, mergeBase) : new Map();
  const toTree = headSha ? treeOf(repo, headSha) : new Map();
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set([...fromTree.keys(), ...toTree.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromTree.get(path);
    const to = toTree.get(path);
    if (from?.sha === to?.sha) continue;
    const fromBytes = from ? blobBytes(repo, from.sha) : Buffer.alloc(0);
    const toBytes = to ? blobBytes(repo, to.sha) : Buffer.alloc(0);
    const fromLines = fromBytes.length === 0 ? 0 : fromBytes.toString('utf8').split('\n').length;
    const toLines = toBytes.length === 0 ? 0 : toBytes.toString('utf8').split('\n').length;
    const status = !from ? 'added' : !to ? 'removed' : 'modified';
    const additions = Math.max(0, toLines - fromLines);
    const deletions = Math.max(0, fromLines - toLines);
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

function treeOf(repo: Repo, commitSha: string): Map<string, { mode: string; sha: string }> {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return new Map();
  return store.flattenTree(repo, parseCommit(obj.data).tree);
}

function blobBytes(repo: Repo, sha: string): Buffer {
  const obj = repo.objects.get(sha);
  return obj && obj.type === 'blob' ? obj.data : Buffer.alloc(0);
}

export function pullJson(repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  return {
    id: pull.id, node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    locked: false, draft: false,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    merged: pull.merged, mergeable: pullMergeable(repo, pull),
    merged_at: pull.merged_at, merge_commit_sha: pull.merge_commit_sha,
    user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' },
    created_at: pull.created_at, updated_at: pull.updated_at, closed_at: pull.state === 'closed' ? pull.updated_at : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// MERGEABLE when head and base have no conflicting change since merge-base.
export function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = store.refTip(repo, pull.baseRef) ?? pull.baseSha;
  if (!pull.headSha || !baseTip) return 'UNKNOWN';
  const mb = store.mergeBase(repo, pull.headSha, baseTip);
  if (mb === null) return 'UNKNOWN';
  const baseTree = treeOf(repo, mb);
  const headTree = treeOf(repo, pull.headSha);
  const baseTipTree = treeOf(repo, baseTip);
  for (const [path, head] of headTree) {
    const atBase = baseTree.get(path);
    if (atBase?.sha === head.sha) continue;
    const atTip = baseTipTree.get(path);
    if (atTip && atTip.sha !== (atBase?.sha ?? null) && atTip.sha !== head.sha) return 'CONFLICTING';
  }
  for (const [path, atBase] of baseTree) {
    if (headTree.has(path)) continue;
    const atTip = baseTipTree.get(path);
    if (atTip && atTip.sha !== atBase.sha) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

export function mergePull(repo: Repo, pull: Pull): { status: number; body: Record<string, unknown> } {
  if (pull.state !== 'open') return { status: 405, body: { message: 'Pull request is already closed' } };
  if (pullMergeable(repo, pull) === 'CONFLICTING') return { status: 405, body: { message: 'Merge conflict' } };
  const baseTip = store.refTip(repo, pull.baseRef) ?? pull.baseSha;
  const mb = store.mergeBase(repo, pull.headSha, baseTip);
  if (mb === null || !pull.headSha || !baseTip) return { status: 405, body: { message: 'Merge conflict' } };
  const baseTree = treeOf(repo, mb);
  const headTree = treeOf(repo, pull.headSha);
  const result = new Map<string, { mode: string; sha: string }>(treeOf(repo, baseTip));
  for (const [path, head] of headTree) {
    const atBase = baseTree.get(path);
    if (atBase?.sha !== head.sha) result.set(path, head);
  }
  for (const path of baseTree.keys()) {
    if (!headTree.has(path)) {
      const atBase = baseTree.get(path);
      const atTip = treeOf(repo, pull.baseSha).get(path);
      if (atTip?.sha === atBase?.sha) result.delete(path);
    }
  }
  const treeSha = store.buildTree(repo, result);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commitSha = store.putObject(repo, 'commit', Buffer.from(
    `tree ${treeSha}\nparent ${baseTip}\nauthor ${OWNER_NAME} <${OWNER_EMAIL}> ${EPOCH_SEC} +0000\ncommitter ${OWNER_NAME} <${OWNER_EMAIL}> ${EPOCH_SEC} +0000\n\n${message}`, 'utf8'));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = nowIso();
  pull.merge_commit_sha = commitSha;
  pull.updated_at = nowIso();
  return { status: 200, body: { sha: commitSha, merged: true, message: 'Pull Request successfully merged' } };
}

function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (/^[0-9a-f]{40}$/i.test(ref)) return repo.objects.has(ref.toLowerCase()) ? ref.toLowerCase() : null;
  return store.refTip(repo, ref);
}

function paginate<T>(items: T[], ctx: RestCtx): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const q = new URLSearchParams(ctx.query);
    q.set('page', String(page + 1));
    q.set('per_page', String(perPage));
    link = `<${ctx.base}${ctx.path}?${q.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function getRepoOr404(ctx: RestCtx, owner: string, name: string): Repo | RestResult {
  if (owner.toLowerCase() !== OWNER_LOGIN) return err(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  return repo;
}

export function handleRest(ctx: RestCtx): RestResult {
  const seg = ctx.path.split('/').filter((s) => s !== '');
  // seg[0]='api', seg[1]='v3'
  const m = ctx.method;
  const body = isRecord(ctx.body) ? ctx.body : {};

  if (m === 'GET' && ctx.path === '/api/v3/meta') {
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_enterprise: false });
  }
  if (m === 'GET' && ctx.path === '/api/v3/user') return ok(200, userJson());
  if (ctx.path === '/api/v3/user/repos') {
    if (m === 'GET') {
      const { page, link } = paginate(store.repoList, ctx);
      return ok(200, page.map((r) => repoJson(r, ctx.base)), link ? { link } : undefined);
    }
    if (m === 'POST') {
      const name = str(body.name);
      if (!name) return err(422, 'name is required');
      if (store.getRepo(OWNER_LOGIN, name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(name, str(body.description), bool(body.private));
      return ok(201, repoJson(repo, ctx.base));
    }
  }
  if (seg[1] === 'v3' && seg[2] === 'repos' && seg.length >= 4) {
    const owner = decodeURIComponent(seg[3] as string);
    const name = decodeURIComponent(seg[4] as string);
    const found = getRepoOr404(ctx, owner, name);
    if (!isRepo(found)) return found;
    const repo = found;
    const rest = seg.slice(5);
    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (m === 'GET') return ok(200, repoJson(repo, ctx.base));
      if (m === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        repo.updated_at = nowIso();
        return ok(200, repoJson(repo, ctx.base));
      }
      if (m === 'DELETE') { store.deleteRepo(repo); return { status: 204, body: null }; }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'branches') {
      if (rest.length === 1 && m === 'GET') {
        const list = [...repo.refs.entries()]
          .filter(([r]) => r.startsWith('refs/heads/'))
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false }));
        return ok(200, list);
      }
      if (rest.length === 2 && m === 'GET') {
        const sha = repo.refs.get(`refs/heads/${decodeURIComponent(rest[1] as string)}`);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { name: decodeURIComponent(rest[1] as string), commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false });
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'commits' && m === 'GET' && rest.length === 1) {
      const shaParam = ctx.query.get('sha');
      const tip = shaParam ? resolveRef(repo, shaParam) : (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null);
      if (!tip) return ok(200, []);
      const list = store.ancestors(repo, tip).map((s) => commitJson(repo, s)).filter((c): c is Record<string, unknown> => c !== null);
      const { page } = paginate(list, ctx);
      return ok(200, page);
    }
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (m === 'POST' && rest.length === 2) {
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha.toLowerCase())) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha.toLowerCase());
        return ok(201, { ref, node_id: globalId('Ref', ref), url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`, object: { sha: sha.toLowerCase(), type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
      }
      if (m === 'GET' && rest.length >= 3) {
        const refPath = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
        const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
        const sha = repo.refs.get(full);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { ref: full, node_id: globalId('Ref', full), object: { sha, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (m === 'PUT') {
        const branch = str(body.branch, repo.defaultBranch);
        const message = str(body.message, `Update ${filePath}`);
        const contentB64 = str(body.content);
        if (!contentB64) return err(422, 'content is required');
        const bytes = Buffer.from(contentB64, 'base64');
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref) ?? null;
        const flat = tip ? treeOf(repo, tip) : new Map<string, { mode: string; sha: string }>();
        const existing = flat.get(filePath);
        const givenSha = str(body.sha);
        if (givenSha && existing && existing.sha !== givenSha.toLowerCase()) return err(409, 'sha does not match the current file');
        if (givenSha && !existing) return err(409, 'sha does not match the current file');
        const isUpdate = existing !== undefined;
        const changes = new Map<string, Buffer | null>([[filePath, bytes]]);
        const commitSha = store.commitFiles(repo, branch, message, changes);
        const blobSha = store.putObject(repo, 'blob', bytes);
        return ok(isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: bytes.length, type: 'file', encoding: 'base64', url: `/api/v3/repos/${owner}/${name}/contents/${filePath}` },
          commit: { sha: commitSha, message },
        });
      }
      if (m === 'GET') {
        const tip = resolveRef(repo, ctx.query.get('ref'));
        if (!tip) return err(404, 'Not Found');
        const flat = treeOf(repo, tip);
        const exact = flat.get(filePath);
        if (exact) {
          const bytes = blobBytes(repo, exact.sha);
          return ok(200, {
            type: 'file', encoding: 'base64', size: bytes.length, name: filePath.split('/').pop(),
            path: filePath, content: bytes.toString('base64'), sha: exact.sha,
            url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
          });
        }
        // directory?
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const dirSha = (dir: string): string => {
          const tipObj = repo.objects.get(tip);
          if (!tipObj || tipObj.type !== 'commit') return '';
          let treeSha = parseCommit(tipObj.data).tree;
          const parts = dir === '' ? [] : dir.split('/');
          for (const part of parts) {
            const t = repo.objects.get(treeSha);
            if (!t || t.type !== 'tree') return '';
            const e = parseTree(t.data).find((x) => x.name === part && x.mode === '40000');
            if (!e) return '';
            treeSha = e.sha;
          }
          return treeSha;
        };
        const entries: Record<string, unknown>[] = [];
        const seenDirs = new Set<string>();
        for (const [p, v] of [...flat.entries()].sort()) {
          if (!p.startsWith(prefix)) continue;
          const rest2 = p.slice(prefix.length);
          const slash = rest2.indexOf('/');
          if (slash === -1) {
            entries.push({ type: 'file', name: rest2, path: p, sha: v.sha, size: blobBytes(repo, v.sha).length, url: `/api/v3/repos/${owner}/${name}/contents/${p}` });
          } else {
            const dir = rest2.slice(0, slash);
            if (!seenDirs.has(dir)) {
              seenDirs.add(dir);
              entries.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: dirSha(`${prefix}${dir}`), size: 0, url: `/api/v3/repos/${owner}/${name}/contents/${prefix}${dir}` });
            }
          }
        }
        if (entries.length === 0) return err(404, 'Not Found');
        return ok(200, entries);
      }
      if (m === 'DELETE') {
        const branch = str(body.branch, repo.defaultBranch);
        const message = str(body.message, `Delete ${filePath}`);
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return err(404, 'Not Found');
        const flat = treeOf(repo, tip);
        const existing = flat.get(filePath);
        if (!existing) return err(404, 'Not Found');
        const givenSha = str(body.sha);
        if (givenSha && existing.sha !== givenSha.toLowerCase()) return err(409, 'sha does not match the current file');
        const changes = new Map<string, Buffer | null>([[filePath, null]]);
        const commitSha = store.commitFiles(repo, branch, message, changes);
        return ok(200, { commit: { sha: commitSha, message } });
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'labels') {
      if (m === 'POST' && rest.length === 1) {
        const name2 = str(body.name);
        if (!name2) return err(422, 'name is required');
        if (!repo.labels.has(name2)) repo.labels.set(name2, { name: name2, color: str(body.color, 'ededed'), description: str(body.description) });
        return ok(201, labelJson(repo, name2));
      }
      if (m === 'GET' && rest.length === 1) {
        return ok(200, [...repo.labels.keys()].map((n) => labelJson(repo, n)));
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (m === 'POST') {
          const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
          for (const l of labels) if (!repo.labels.has(l)) return err(422, `Label "${l}" does not exist`);
          const issue = store.createIssue(repo, str(body.title), str(body.body), labels);
          return ok(201, issueJson(repo, issue, ctx.base));
        }
        if (m === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = ctx.query.get('sort') ?? 'created';
          const dir = ctx.query.get('direction') ?? 'desc';
          if (sort === 'created') list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { page } = paginate(list, ctx);
          return ok(200, page.map((i) => issueJson(repo, i, ctx.base)));
        }
      }
      const num = Number(rest[1]);
      const issue = repo.issueByNum.get(num);
      if (rest.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (m === 'GET') return { status: 200, body: null, bodyText: cachedIssueJsonText(repo, issue, ctx.base) };
        if (m === 'PATCH') {
          if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const labels = body.labels.filter((l): l is string => typeof l === 'string');
            for (const l of labels) if (!repo.labels.has(l)) return err(422, `Label "${l}" does not exist`);
            issue.labels = labels;
          }
          issue.updated_at = nowIso();
          invalidateIssueJson(repo, issue);
          return ok(200, issueJson(repo, issue, ctx.base));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (m === 'POST') {
          const id = repo.nextComment;
          repo.nextComment += 1;
          const comment = { id, body: str(body.body), created_at: nowIso(), updated_at: nowIso() };
          issue.comments.push(comment);
          invalidateIssueJson(repo, issue);
          return ok(201, { id, node_id: globalId('Comment', repo.id, issue.number, id), body: comment.body, user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' }, created_at: comment.created_at, updated_at: comment.updated_at, html_url: `https://github.com/${owner}/${name}/issues/${num}#issuecomment-${id}` });
        }
        if (m === 'GET') {
          return ok(200, issue.comments.map((c) => ({ id: c.id, node_id: globalId('Comment', repo.id, issue.number, c.id), body: c.body, user: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User' }, created_at: c.created_at, updated_at: c.updated_at })));
        }
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (m === 'POST') {
          const head = str(body.head);
          const base2 = str(body.base, repo.defaultBranch);
          const pull = store.createPull(repo, str(body.title), str(body.body), head, base2);
          return ok(201, pullJson(repo, pull, ctx.base));
        }
        if (m === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page } = paginate(list, ctx);
          return ok(200, page.map((p) => pullJson(repo, p, ctx.base)));
        }
      }
      const num = Number(rest[1]);
      const pull = repo.pullByNum.get(num);
      if (!pull) return err(404, 'Not Found');
      if (rest.length === 2 && m === 'GET') return ok(200, pullJson(repo, pull, ctx.base));
      if (rest.length === 3 && rest[2] === 'files' && m === 'GET') {
        return ok(200, pullFiles(repo, pull).map((f) => ({ ...f, sha: '', patch: undefined, blob_url: '', raw_url: '', contents_url: '' })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && m === 'PUT') {
        const result = mergePull(repo, pull);
        return ok(result.status, result.body);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

function isRepo(v: Repo | RestResult): v is Repo {
  return (v as Repo).refs !== undefined && (v as Repo).objects !== undefined;
}
