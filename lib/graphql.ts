// GitHub GraphQL v4, for exactly the documents gh and github-mcp-server send:
// a small recursive-descent parser, a schema map with introspection, and
// resolvers over the same store REST uses. Unknown fields answer HTTP 200
// with an errors array naming the field; unknown repositories read null.
import { decodeGlobalId, globalId, mergePull, pullFiles, pullMergeable } from './rest.ts';
import { OWNER_ID, OWNER_LOGIN, OWNER_NAME, nowIso, store, type Issue, type Pull, type Repo } from './store.ts';

// ------------------------------------------------------------------ parser
type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldSel {
  kind: 'field'; alias: string | null; name: string;
  args: Record<string, Value>; selections: Selection[];
}
interface FragSel { kind: 'fragment'; type: string | null; selections: Selection[]; }
interface SpreadSel { kind: 'spread'; name: string; }
type Selection = FieldSel | FragSel | SpreadSel;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  vars: Record<string, Value>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) { this.src = src; }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos] as string;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { this.pos += 1; continue; }
      if (c === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1; continue; }
      break;
    }
  }
  private peek(): string { this.skipWs(); return this.src[this.pos] ?? ''; }
  private eat(ch: string): boolean {
    this.skipWs();
    if (this.src[this.pos] === ch) { this.pos += 1; return true; }
    return false;
  }
  private expect(ch: string): void { if (!this.eat(ch)) throw new Error(`expected ${ch} at ${this.pos}`); }
  private name(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }
  private string(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos] as string;
      this.pos += 1;
      if (c === '"') return out;
      if (c === '\\') {
        const e = this.src[this.pos] as string; this.pos += 1;
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
      } else out += c;
    }
    throw new Error('unterminated string');
  }
  private value(): Value {
    this.skipWs();
    const c = this.src[this.pos] as string;
    if (c === '$') { this.pos += 1; return { kind: 'var', name: this.name() }; }
    if (c === '"') return { kind: 'string', value: this.string() };
    if (c === '[') {
      this.pos += 1;
      const items: Value[] = [];
      while (!this.eat(']')) items.push(this.value());
      return { kind: 'list', items };
    }
    if (c === '{') {
      this.pos += 1;
      const fields: Record<string, Value> = {};
      while (!this.eat('}')) {
        const k = this.name();
        this.expect(':');
        fields[k] = this.value();
      }
      return { kind: 'object', fields };
    }
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (m && /[0-9]/.test(c)) {
      this.pos += m[0].length;
      return m[0].includes('.') || /[eE]/.test(m[0]) ? { kind: 'float', value: Number(m[0]) } : { kind: 'int', value: Number(m[0]) };
    }
    const word = this.name();
    if (word === 'true') return { kind: 'bool', value: true };
    if (word === 'false') return { kind: 'bool', value: false };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }
  private args(): Record<string, Value> {
    const out: Record<string, Value> = {};
    if (!this.eat('(')) return out;
    while (!this.eat(')')) {
      const k = this.name();
      this.expect(':');
      out[k] = this.value();
    }
    return out;
  }
  private selections(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (!this.eat('}')) {
      if (this.peek() === '.' && this.src.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        this.skipWs();
        if (this.src.slice(this.pos, this.pos + 2) === 'on') {
          this.pos += 2;
          const type = this.name();
          out.push({ kind: 'fragment', type, selections: this.selections() });
        } else {
          out.push({ kind: 'spread', name: this.name() });
        }
        continue;
      }
      const first = this.name();
      let alias: string | null = null;
      let fieldName = first;
      if (this.eat(':')) { alias = first; fieldName = this.name(); }
      const args = this.args();
      // directives (@...) are not sent by the suite; skip any we meet.
      while (this.peek() === '@') { this.pos += 1; this.name(); this.args(); }
      const sels = this.peek() === '{' ? this.selections() : [];
      out.push({ kind: 'field', alias, name: fieldName, args, selections: sels });
    }
    return out;
  }
  parseDocument(): { operations: Operation[]; fragments: Record<string, Selection[]> } {
    const operations: Operation[] = [];
    const fragments: Record<string, Selection[]> = {};
    while (true) {
      this.skipWs();
      if (this.pos >= this.src.length) break;
      if (this.peek() === '{') {
        operations.push({ kind: 'query', name: null, vars: {}, selections: this.selections() });
        continue;
      }
      const kw = this.name();
      if (kw === 'fragment') {
        const fname = this.name();
        this.expect('on');
        this.name();
        fragments[fname] = this.selections();
        continue;
      }
      if (kw !== 'query' && kw !== 'mutation') throw new Error(`unexpected ${kw}`);
      let opName: string | null = null;
      this.skipWs();
      if (/[A-Za-z_]/.test(this.peek())) opName = this.name();
      const vars: Record<string, Value> = {};
      if (this.eat('(')) {
        while (!this.eat(')')) {
          this.eat('$');
          const vname = this.name();
          this.expect(':');
          // type: skip until , or ) at depth 0 — types are simple here
          let depth = 0;
          while (this.pos < this.src.length) {
            const c = this.src[this.pos] as string;
            if (c === '[') depth += 1;
            else if (c === ']') depth -= 1;
            else if (depth === 0 && (c === ',' || c === ')')) break;
            else if (depth === 0 && c === '=') break;
            this.pos += 1;
          }
          if (this.peek() === '=') { this.pos += 1; this.value(); }
          vars[vname] = { kind: 'null' };
        }
      }
      operations.push({ kind: kw, name: opName, vars, selections: this.selections() });
    }
    return { operations, fragments };
  }
}

function resolveValue(v: Value, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return variables[v.name] ?? null;
    case 'string': return v.value;
    case 'int': case 'float': return v.value;
    case 'bool': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = resolveValue(val, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'url'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  Ref: ['name'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  AddCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeNameOf(parent: unknown, field: string): string {
  if (field === 'viewer') return 'User';
  if (field === 'repository') return 'Repository';
  if (field === 'node') {
    const t = (parent as { __type?: string }).__type;
    return t === 'AddCommentEdge' ? 'IssueComment' : 'Repository';
  }
  if (field === 'owner') return 'User';
  if (field === 'defaultBranchRef') return 'Ref';
  if (field === 'issue') return 'Issue';
  if (field === 'issues') return 'IssueConnection';
  if (field === 'pullRequests') return 'PullRequestConnection';
  if (field === 'pullRequest') return 'PullRequest';
  if (field === 'files') return 'PullRequestChangedFileConnection';
  if (field === 'nodes') {
    const t = (parent as { __type?: string }).__type;
    if (t === 'IssueConnection') return 'Issue';
    if (t === 'PullRequestConnection') return 'PullRequest';
    if (t === 'PullRequestChangedFileConnection') return 'PullRequestChangedFile';
    return 'Issue';
  }
  if (field === 'pageInfo') return 'PageInfo';
  if (field === 'createIssue') return 'CreateIssuePayload';
  if (field === 'closeIssue') return 'CloseIssuePayload';
  if (field === 'createPullRequest') return 'CreatePullRequestPayload';
  if (field === 'mergePullRequest') return 'MergePullRequestPayload';
  if (field === 'addComment') return 'AddCommentPayload';
  if (field === 'commentEdge') return 'AddCommentEdge';
  if (field === '__type') return '__Type';
  if (field === 'fields') return '__Field';
  if (field === 'enumValues') return '__EnumValue';
  if (field === 'issue') return 'Issue';
  return 'String';
}

// ------------------------------------------------------------------ executor
interface Ctx { variables: Record<string, unknown>; errors: { message: string }[]; fragments: Record<string, Selection[]>; }

function rawRepo(p: Record<string, unknown>): Repo {
  return ((p as { __repo?: Repo }).__repo ?? p) as Repo;
}

function fieldValue(parent: unknown, field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const p = parent as Record<string, unknown> & { __type?: string };
  const ptype = p.__type as string | undefined;
  switch (field) {
    case '__typename': return ptype ?? 'Query';
    case 'viewer': return { __type: 'User', login: OWNER_LOGIN, id: globalId('User', OWNER_ID), name: OWNER_NAME, email: `${OWNER_LOGIN}@example.invalid` };
    case 'repository': {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner.toLowerCase() !== OWNER_LOGIN) return null;
      const repo = store.getRepo(owner, name);
      return repo ? repoView(repo) : null;
    }
    case 'node': {
      if ((p as { __type?: string }).__type !== 'Query') return (p as Record<string, unknown>).node ?? null;
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded || decoded.kind !== 'Repository') return null;
      const repo = store.repoList.find((r) => r.id === Number(decoded.parts[0]));
      return repo ? repoView(repo) : null;
    }
    case '__type': {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name]) return { __type: '__Type', name, kind: 'OBJECT', fields: TYPE_FIELDS[name].map((f) => ({ __type: '__Field', name: f })), enumValues: [] };
      if (ENUM_VALUES[name]) return { __type: '__Type', name, kind: 'ENUM', fields: [], enumValues: ENUM_VALUES[name].map((f) => ({ __type: '__EnumValue', name: f })) };
      return null;
    }
    case 'owner': return { __type: 'User', login: OWNER_LOGIN, id: globalId('User', OWNER_ID), name: OWNER_NAME };
    case 'defaultBranchRef': {
      const repo = rawRepo(p);
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __type: 'Ref', name: repo.defaultBranch } : null;
    }
    case 'issue': {
      if ((p as { __type?: string }).__type !== 'Repository') return (p as Record<string, unknown>).issue ?? null;
      const repo = rawRepo(p);
      const issue = repo.issueByNum.get(Number(args.number));
      return issue ? issueView(repo, issue) : null;
    }
    case 'issues': return issuesConnection(rawRepo(p), args);
    case 'pullRequests': return pullRequestsConnection(rawRepo(p), args);
    case 'pullRequest': {
      if ((p as { __type?: string }).__type !== 'Repository') return (p as Record<string, unknown>).pullRequest ?? null;
      const repo = rawRepo(p);
      const pull = repo.pullByNum.get(Number(args.number));
      return pull ? pullView(repo, pull) : null;
    }
    case 'files': {
      const pull = (p as unknown as { __pull?: Pull; __repo?: Repo }).__pull as Pull;
      const repo = (p as unknown as { __repo?: Repo }).__repo as Repo;
      const files = pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : files.length;
      return { __type: 'PullRequestChangedFileConnection', nodes: files.slice(0, first).map((f) => ({ __type: 'PullRequestChangedFile', path: f.filename })), pageInfo: { __type: 'PageInfo', hasNextPage: files.length > first, endCursor: null } };
    }
    case 'createIssue': return createIssueMut(args);
    case 'closeIssue': return closeIssueMut(args);
    case 'createPullRequest': return createPullRequestMut(args);
    case 'mergePullRequest': return mergePullRequestMut(args, ctx);
    case 'addComment': return addCommentMut(args);
    default: {
      // Plain scalar fields stored on the view objects.
      if (p !== null && typeof p === 'object' && field in p) return (p as Record<string, unknown>)[field];
      return undefined;
    }
  }
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    __type: 'Repository', id: globalId('Repository', repo.id), databaseId: repo.id,
    name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    createdAt: repo.created_at, updatedAt: repo.updated_at,
    description: repo.description, url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    __repo: repo,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __type: 'Issue', id: globalId('Issue', repo.id, issue.number),
    number: issue.number, title: issue.title, state: issue.state.toUpperCase(), body: issue.body,
    createdAt: issue.created_at, updatedAt: issue.updated_at,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __type: 'PullRequest', id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number, title: pull.title, state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged, headRefName: pull.headRef, baseRefName: pull.baseRef,
    mergeable: pullMergeable(repo, pull), body: pull.body,
    createdAt: pull.created_at, updatedAt: pull.updated_at,
    __pull: pull, __repo: repo,
  };
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}
function cursorNumber(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) list = list.filter((i) => states.includes(i.state.toUpperCase()));
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const dir = String(orderBy?.direction ?? 'DESC').toUpperCase();
  list.sort((a, b) => (dir === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const afterNum = cursorNumber(args.after as string | null);
  if (afterNum !== null) {
    const idx = list.findIndex((i) => i.number === afterNum);
    if (idx >= 0) list = list.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const nodes = list.slice(0, first);
  return {
    __type: 'IssueConnection',
    nodes: nodes.map((i) => issueView(repo, i)),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: list.length > first,
      endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]?.number as number) : null,
      hasPreviousPage: false, startCursor: nodes.length > 0 ? cursorFor(nodes[0]?.number as number) : null,
    },
    totalCount: list.length,
  };
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const nodes = list.slice(0, first);
  return {
    __type: 'PullRequestConnection',
    nodes: nodes.map((p) => pullView(repo, p)),
    pageInfo: { __type: 'PageInfo', hasNextPage: list.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
    totalCount: list.length,
  };
}

function findRepoById(id: number): Repo | undefined {
  return store.repoList.find((r) => r.id === id);
}

function createIssueMut(args: Record<string, unknown>): Record<string, unknown> {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
  const repo = decoded ? findRepoById(Number(decoded.parts[0])) : undefined;
  if (!repo) return { __type: 'CreateIssuePayload', issue: null };
  const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
  return { __type: 'CreateIssuePayload', issue: issueView(repo, issue) };
}

function closeIssueMut(args: Record<string, unknown>): Record<string, unknown> {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(String(input.issueId ?? ''));
  if (!decoded || decoded.kind !== 'Issue') return { __type: 'CloseIssuePayload', issue: null };
  const repo = findRepoById(Number(decoded.parts[0]));
  const issue = repo?.issueByNum.get(Number(decoded.parts[1]));
  if (!repo || !issue) return { __type: 'CloseIssuePayload', issue: null };
  issue.state = 'closed';
  issue.updated_at = nowIso();
  return { __type: 'CloseIssuePayload', issue: issueView(repo, issue) };
}

function createPullRequestMut(args: Record<string, unknown>): Record<string, unknown> {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
  const repo = decoded ? findRepoById(Number(decoded.parts[0])) : undefined;
  if (!repo) return { __type: 'CreatePullRequestPayload', pullRequest: null };
  const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? repo.defaultBranch));
  return { __type: 'CreatePullRequestPayload', pullRequest: pullView(repo, pull) };
}

function mergePullRequestMut(args: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
  if (!decoded || decoded.kind !== 'PullRequest') return { __type: 'MergePullRequestPayload', pullRequest: null };
  const repo = findRepoById(Number(decoded.parts[0]));
  const pull = repo?.pullByNum.get(Number(decoded.parts[1]));
  if (!repo || !pull) return { __type: 'MergePullRequestPayload', pullRequest: null };
  const result = mergePull(repo, pull);
  if (result.status !== 200) {
    ctx.errors.push({ message: `Merge conflict: ${String((result.body as Record<string, unknown>).message ?? '')}` });
    return { __type: 'MergePullRequestPayload', pullRequest: null };
  }
  return { __type: 'MergePullRequestPayload', pullRequest: pullView(repo, pull) };
}

function addCommentMut(args: Record<string, unknown>): Record<string, unknown> {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(String(input.subjectId ?? ''));
  if (!decoded || decoded.kind !== 'Issue') return { __type: 'AddCommentPayload', commentEdge: null };
  const repo = findRepoById(Number(decoded.parts[0]));
  const issue = repo?.issueByNum.get(Number(decoded.parts[1]));
  if (!repo || !issue) return { __type: 'AddCommentPayload', commentEdge: null };
  const id = repo.nextComment;
  repo.nextComment += 1;
  const body = String(input.body ?? '');
  issue.comments.push({ id, body, created_at: nowIso(), updated_at: nowIso() });
  return {
    __type: 'AddCommentPayload',
    commentEdge: { __type: 'AddCommentEdge', node: { __type: 'IssueComment', id: globalId('Comment', repo.id, issue.number, id), body } },
  };
}

function executeSelections(parent: unknown, parentType: string, selections: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments[sel.name];
      if (frag) Object.assign(out, executeSelections(parent, parentType, frag, ctx));
      continue;
    }
    if (sel.kind === 'fragment') {
      const parentObj = parent as { __type?: string } | null;
      if (sel.type && parentObj?.__type && parentObj.__type !== sel.type) continue;
      Object.assign(out, executeSelections(parent, parentType, sel.selections, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') { out[key] = parentType; continue; }
    const fields = TYPE_FIELDS[parentType] ?? [];
    if (!fields.includes(sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, ctx.variables);
    const value = fieldValue(parent, sel.name, args, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    if (sel.selections.length === 0 || value === null) { out[key] = value; continue; }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => executeSelections(item, typeNameOf(parent, sel.name), sel.selections, ctx));
      continue;
    }
    out[key] = executeSelections(value, typeNameOf(parent, sel.name), sel.selections, ctx);
  }
  return out;
}

export function executeGraphQL(body: unknown): { status: number; body: unknown } {
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!doc || typeof doc !== 'object') return { data: null, errors: [{ message: 'request body must be an object' }] };
    const d = doc as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof d.query !== 'string') return { data: null, errors: [{ message: 'query must be a string' }] };
    const variables = (d.variables !== null && typeof d.variables === 'object' ? d.variables : {}) as Record<string, unknown>;
    let parsed;
    try {
      parsed = new Parser(d.query).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
    }
    const operations = parsed.operations.filter((o) => d.operationName === undefined || d.operationName === null || o.name === d.operationName);
    if (operations.length === 0) return { data: null, errors: [{ message: `unknown operation ${String(d.operationName ?? '')}` }] };
    const op = operations[0] as Operation;
    const ctx: Ctx = { variables, errors: [], fragments: parsed.fragments };
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelections({ __type: rootType }, rootType, op.selections, ctx);
    if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
    return { data };
  };
  if (Array.isArray(body)) return { status: 200, body: body.map(runOne) };
  return { status: 200, body: runOne(body) };
}
