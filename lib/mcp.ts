// Model Context Protocol over Streamable HTTP: JSON-RPC 2.0, modern revision
// 2026-07-28 via server/discover, with the legacy initialize handshake as a
// fallback. Tools act on the same store as REST and GraphQL.
import { issueJson, mergePull, pullJson, repoJson } from './rest.ts';
import { OWNER_LOGIN, store } from './store.ts';

export const MCP_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'makefun-git-forge', version: '1.0.0' };

interface ToolDef {
  name: string; description: string;
  inputSchema: { type: string; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo', description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        owner: { type: 'string', description: 'Owner login' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo', description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue', description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues', description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request', description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request', description: 'Merge a pull request by number, closing it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) { owner = parts[0] as string; repo = parts[1] as string; }
  }
  return { owner, repo };
}

function toolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = (canonical: string, aliases: string[]): boolean =>
    norm === canonical || norm.endsWith(canonical) || aliases.some((a) => norm === a || norm.endsWith(a));
  if (match('createrepo', ['createrepository', 'repocreate', 'reposcreate', 'repositorycreate'])) {
    const repoName = typeof args.name === 'string' ? args.name : (typeof args.repo === 'string' ? args.repo : '');
    if (!repoName) return toolError('missing required argument: name');
    if (store.getRepo(OWNER_LOGIN, repoName)) return toolError(`repository ${repoName} already exists`);
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : OWNER_LOGIN;
    const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    void owner;
    return toolResult({ ...repoJson(repo, ''), full_name: `${repo.owner}/${repo.name}`, name: repo.name, owner: repo.owner, id: repo.id, private: repo.private, description: repo.description });
  }
  if (match('getrepo', ['getrepository', 'repoget', 'reposget', 'repositoryget'])) {
    const { owner, repo: repoName } = splitFullName(args);
    if (!owner || !repoName) return toolError('missing required argument: owner or repo');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
    return toolResult({ ...repoJson(repo, ''), full_name: `${repo.owner}/${repo.name}`, name: repo.name, owner: repo.owner, id: repo.id });
  }
  if (match('createissue', ['issuecreate', 'issuescreate'])) {
    const { owner, repo: repoName } = splitFullName(args);
    const title = typeof args.title === 'string' ? args.title : '';
    if (!owner || !repoName || !title) return toolError('missing required argument: owner, repo or title');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
    const issue = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
    return toolResult({ ...issueJson(repo, issue, ''), full_name: `${repo.owner}/${repo.name}`, number: issue.number, id: issue.id, title: issue.title, body: issue.body, state: issue.state });
  }
  if (match('listissues', ['issueslist', 'issuelist'])) {
    const { owner, repo: repoName } = splitFullName(args);
    if (!owner || !repoName) return toolError('missing required argument: owner or repo');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.seq - a.seq);
    return toolResult({ issues: list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state })), total_count: list.length });
  }
  if (match('createpullrequest', ['pullrequestcreate', 'pullscreate', 'createpr', 'prcreate'])) {
    const { owner, repo: repoName } = splitFullName(args);
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    if (!owner || !repoName || !title || !head || !base) return toolError('missing required argument: owner, repo, title, head or base');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
    const pull = store.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
    return toolResult({ ...pullJson(repo, pull, ''), full_name: `${repo.owner}/${repo.name}`, number: pull.number, pull_number: pull.number, id: pull.id, title: pull.title, head, base, state: pull.state });
  }
  if (match('mergepullrequest', ['pullrequestmerge', 'pullsmerge', 'mergepr', 'prmerge'])) {
    const { owner, repo: repoName } = splitFullName(args);
    const num = Number(args.pull_number ?? args.number);
    if (!owner || !repoName || !Number.isFinite(num)) return toolError('missing required argument: owner, repo or pull_number');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
    const pull = repo.pullByNum.get(num);
    if (!pull) return toolError(`pull request ${num} not found`);
    const result = mergePull(repo, pull);
    if (result.status !== 200) return toolError(String((result.body as Record<string, unknown>).message ?? 'merge failed'));
    return toolResult({ merged: true, number: pull.number, pull_number: pull.number, id: pull.id, sha: result.body.sha, state: pull.state });
  }
  return { __unknownTool: true };
}

export interface McpOutcome { status: number; body: unknown; headers?: Record<string, string>; }

export function handleMcp(rawBody: Buffer): McpOutcome {
  let doc: unknown;
  try {
    doc = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { status: 200, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = doc as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
  const result = (r: unknown, headers?: Record<string, string>): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, result: r }, headers });
  const error = (code: number, message: string): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'server/discover') {
    return result({
      protocolVersion: MCP_VERSION,
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const offered = String((params as Record<string, unknown>).protocolVersion ?? '');
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : MCP_VERSION;
    return result(
      { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      { 'mcp-session-id': 'mcp-session-1' },
    );
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }
  if (method === 'ping') return result({});
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    // Missing required arguments, checked against the matched tool's schema.
    const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const tool = TOOLS.find((t) => {
      const tn = t.name.replace(/[^a-z0-9]/g, '');
      return norm === tn || norm.endsWith(tn);
    });
    if (!tool) return error(-32601, `unknown tool: ${name}`);
    for (const reqArg of tool.inputSchema.required) {
      if (args[reqArg] === undefined || args[reqArg] === null || args[reqArg] === '') {
        return result({ content: [{ type: 'text', text: `missing required argument: ${reqArg}` }], isError: true });
      }
    }
    const out = callTool(name, args);
    if ((out as { __unknownTool?: boolean }).__unknownTool) return error(-32601, `unknown tool: ${name}`);
    return result(out);
  }
  return error(-32601, `method not found: ${method}`);
}
