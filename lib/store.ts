// In-memory store for the forge: git objects, refs, repos, issues, pulls.
// Everything is deterministic: no wall clock, no Math.random. Timestamps come
// from MAKEFUN_TRIAL_NOW when the trial sets it, else a fixed epoch string.
import { createHash } from 'node:crypto';

// The token owner's login, from the kit's fixed scenario (wire.ts SCENARIO_SEED
// is a constant, so buildScenario() yields the same viewer in every trial:
// id 1000, login adaiversen, name "ada iversen"). The suite addresses every
// repository, git remote and GraphQL query under this login, and expects a
// different login's repository to 404, never 403.
export const OWNER_LOGIN = 'adaiversen';
export const OWNER_ID = 1000;
export const OWNER_NAME = 'ada iversen';
export const OWNER_EMAIL = 'adaiversen@example.invalid';
export const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, the scenario epoch
export const FIXED_ISO = '2025-01-01T00:00:00Z';

export function nowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw.includes('T')) return raw;
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    if (Number.isFinite(ms)) return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return FIXED_ISO;
}

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObj { type: ObjType; data: Buffer; }

export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  // Stream the header and the data into the hash: the old Buffer.concat copied
  // the whole object (a 1 KiB blob on every push) just to hash it.
  return createHash('sha1').update(head).update(data).digest('hex');
}

export interface TreeEntry { mode: string; name: string; sha: string; }

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(i, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

export interface CommitInfo {
  tree: string; parents: string[]; message: string;
  authorName: string; authorEmail: string; epoch: number;
}

export function serializeCommit(c: CommitInfo): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.authorName} <${c.authorEmail}> ${c.epoch} +0000\n`;
  s += `committer ${c.authorName} <${c.authorEmail}> ${c.epoch} +0000\n`;
  s += `\n${c.message}`;
  return Buffer.from(s, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const message = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let authorName = OWNER_NAME;
  let authorEmail = OWNER_EMAIL;
  let epoch = EPOCH_SEC;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = /^author (.*) <(.*)> (\d+) /.exec(line);
      if (m) { authorName = m[1] ?? authorName; authorEmail = m[2] ?? authorEmail; epoch = Number(m[3]); }
    }
  }
  return { tree, parents, message, authorName, authorEmail, epoch };
}

export interface TagInfo { object: string; type: string; tag: string; taggerName: string; taggerEmail: string; epoch: number; message: string; }

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const message = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let taggerName = OWNER_NAME;
  let taggerEmail = OWNER_EMAIL;
  let epoch = EPOCH_SEC;
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) {
      const m = /^tagger (.*) <(.*)> (\d+) /.exec(line);
      if (m) { taggerName = m[1] ?? taggerName; taggerEmail = m[2] ?? taggerEmail; epoch = Number(m[3]); }
    }
  }
  return { object, type, tag, taggerName, taggerEmail, epoch, message };
}

export interface Label { name: string; color: string; description: string; }
export interface Comment { id: number; body: string; created_at: string; updated_at: string; }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: Comment[]; created_at: string; updated_at: string; seq: number;
}
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  created_at: string; updated_at: string; seq: number;
}

export interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  labels: Map<string, Label>;
  issues: Issue[]; issueByNum: Map<number, Issue>;
  pulls: Pull[]; pullByNum: Map<number, Pull>;
  nextIssue: number; nextPull: number; nextComment: number;
  created_at: string; updated_at: string;
}

export class Store {
  repos = new Map<string, Repo>(); // key: owner/name (lowercased owner+name)
  repoList: Repo[] = [];
  nextRepoId = 5000;
  nextIssueId = 10000;
  nextPullId = 20000;
  private seqCounter = 0;

  seq(): number { this.seqCounter += 1; return this.seqCounter; }

  key(owner: string, name: string): string { return `${owner.toLowerCase()}/${name.toLowerCase()}`; }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId, name, owner: OWNER_LOGIN, description, private: isPrivate,
      defaultBranch: 'main', refs: new Map(), objects: new Map(),
      labels: new Map(), issues: [], issueByNum: new Map(),
      pulls: [], pullByNum: new Map(),
      nextIssue: 1, nextPull: 1, nextComment: 1,
      created_at: nowIso(), updated_at: nowIso(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(OWNER_LOGIN, name), repo);
    this.repoList.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    const i = this.repoList.indexOf(repo);
    if (i >= 0) this.repoList.splice(i, 1);
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObj | undefined {
    return repo.objects.get(sha.toLowerCase());
  }

  // Walk first-parent + all parents from a tip; returns shas in visit order.
  ancestors(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      out.push(sha);
      const info = parseCommit(obj.data);
      for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
    }
    return out;
  }

  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    // Walk from `desc` and stop as soon as `anc` is found. The old code walked
    // the ENTIRE history first (ancestors() parses every commit back to the
    // root) and only then checked membership — O(history) on every push, so a
    // 600-push chain paid ~180k commit parses. A push's old ref is normally the
    // immediate parent, so this is usually one step.
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === anc) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancA = new Set(this.ancestors(repo, a));
    for (const sha of this.ancestors(repo, b)) {
      if (ancA.has(sha)) return sha;
    }
    return null;
  }

  // Flatten a tree (recursively) to path -> {mode, sha}
  flattenTree(repo: Repo, treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const obj = repo.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') {
        for (const [k, v] of this.flattenTree(repo, e.sha, path)) out.set(k, v);
      } else {
        out.set(path, { mode: e.mode, sha: e.sha });
      }
    }
    return out;
  }

  // Build a tree from a flat path map (nested dirs created as needed).
  buildTree(repo: Repo, flat: Map<string, { mode: string; sha: string }>): string {
    return this.buildTreeFromFlat(repo, flat, '');
  }

  private buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; sha: string }>, prefix: string): string {
    const entries: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, v] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.push({ mode: v.mode, name: rest, sha: v.sha });
      else dirs.add(rest.slice(0, slash));
    }
    for (const dir of dirs) {
      const subPrefix = `${prefix}${dir}/`;
      const filtered = new Map<string, { mode: string; sha: string }>();
      for (const [p, v] of flat) if (p.startsWith(subPrefix)) filtered.set(p, v);
      entries.push({ mode: '40000', name: dir, sha: this.buildTreeFromFlat(repo, filtered, subPrefix) });
    }
    return this.putObject(repo, 'tree', serializeTree(entries));
  }

  // Create a commit on top of `parent` (null = root) applying file changes.
  commitFiles(repo: Repo, branch: string, message: string, changes: Map<string, Buffer | null>, parentOverride?: string | null): string {
    const ref = `refs/heads/${branch}`;
    const parent = parentOverride !== undefined ? parentOverride : (repo.refs.get(ref) ?? null);
    let flat = new Map<string, { mode: string; sha: string }>();
    if (parent !== null) {
      const obj = repo.objects.get(parent);
      if (obj && obj.type === 'commit') flat = this.flattenTree(repo, parseCommit(obj.data).tree);
    }
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else {
        const blobSha = this.putObject(repo, 'blob', content);
        flat.set(path, { mode: '100644', sha: blobSha });
      }
    }
    const treeSha = this.buildTree(repo, flat);
    const parents = parent === null ? [] : [parent];
    const commitSha = this.putObject(repo, 'commit', serializeCommit({
      tree: treeSha, parents, message,
      authorName: OWNER_NAME, authorEmail: OWNER_EMAIL, epoch: EPOCH_SEC,
    }));
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  refTip(repo: Repo, refName: string): string | null {
    // refName may be a branch name or full ref
    const full = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
    return repo.refs.get(full) ?? null;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const n = repo.nextIssue;
    repo.nextIssue += 1;
    const stamp = nowIso();
    const issue: Issue = {
      id: this.nextIssueId, number: n, title, body, state: 'open',
      labels: [...labels], comments: [], created_at: stamp, updated_at: stamp, seq: this.seq(),
    };
    this.nextIssueId += 1;
    repo.issues.push(issue);
    repo.issueByNum.set(n, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const n = repo.nextPull;
    repo.nextPull += 1;
    const headSha = this.refTip(repo, headRef) ?? '';
    const baseSha = this.refTip(repo, baseRef) ?? '';
    const pull: Pull = {
      id: this.nextPullId, number: n, title, body, state: 'open',
      headRef, baseRef, headSha, baseSha,
      merged: false, merged_at: null, merge_commit_sha: null,
      created_at: nowIso(), updated_at: nowIso(), seq: this.seq(),
    };
    this.nextPullId += 1;
    repo.pulls.push(pull);
    repo.pullByNum.set(n, pull);
    return pull;
  }
}

export const store = new Store();
