// The forge's HTTP server: health probe, API root, REST v3, GraphQL v4, MCP
// and git smart HTTP, all over one in-memory store. Standard library only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './lib/graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './lib/githttp.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleRest, nextRequestId } from './lib/rest.ts';
import { store } from './lib/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true; // no token configured (local runs without one)
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const buf = body === null ? null : Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  const headers: Record<string, string> = {
    'x-github-request-id': nextRequestId(),
    ...extra,
  };
  if (buf !== null) {
    headers['content-type'] = JSON_TYPE;
    headers['content-length'] = String(buf.length);
  }
  res.writeHead(status, headers);
  res.end(buf ?? '');
}

/** Send an already-serialized JSON body byte-for-byte (the cached issue-read path). */
function sendJsonText(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'x-github-request-id': nextRequestId(),
    'content-type': JSON_TYPE,
    'content-length': String(buf.length),
    ...extra,
  });
  res.end(buf);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  // A request that cannot carry a body (a GET/HEAD/DELETE with no
  // Content-Length and no chunked encoding — the read workload's 2,000 GETs)
  // resolves at once instead of waiting a tick for the stream's 'end' event.
  const len = req.headers['content-length'];
  if (
    (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') &&
    (len === undefined || len === '0') &&
    req.headers['transfer-encoding'] === undefined
  ) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): string {
  // The request-target's path without its query string. new URL() here cost a
  // full URL parse on every request; the path is just the part before '?'
  // (percent-encoding is preserved, exactly as URL.pathname would keep it).
  const u = req.url ?? '/';
  const q = u.indexOf('?');
  const p = q === -1 ? u : u.slice(0, q);
  if (p === '') return '/';
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const u = req.url ?? '/';
  const q = u.indexOf('?');
  return new URLSearchParams(q === -1 ? '' : u.slice(q + 1));
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // Every other surface requires the trial bearer token.
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }

      const raw = await readBody(req);

      // GraphQL v4
      if (path === '/api/graphql') {
        if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
        let doc: unknown;
        try {
          doc = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const out = executeGraphQL(doc);
        sendJson(res, out.status, out.body);
        return;
      }

      // MCP over Streamable HTTP
      if (path === '/mcp') {
        if (method === 'DELETE') { sendJson(res, 202, null); return; }
        if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
        const out = handleMcp(raw);
        if (out.status === 202) { sendJson(res, 202, null); return; }
        sendJson(res, out.status, out.body, out.headers ?? {});
        return;
      }

      // REST v3
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        let parsed: unknown = undefined;
        if (raw.length > 0) {
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
        }
        let url: URLSearchParams;
        try {
          url = queryOf(req);
        } catch {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const base = `http://${req.headers.host ?? '127.0.0.1'}`;
        const result = handleRest({ method, path, query: url, body: parsed, base });
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': nextRequestId() });
          res.end();
          return;
        }
        if (result.bodyText !== undefined) { sendJsonText(res, result.status, result.bodyText, result.headers ?? {}); return; }
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/<service>
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const service = gitMatch[3] ?? '';
        const repo = store.getRepo(owner, repoName);
        const protocol2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        if (service === 'info/refs') {
          const serviceParam = queryOf(req).get('service') ?? '';
          const out = handleInfoRefs(repo, serviceParam, protocol2);
          if (out.status === 404) { sendJson(res, 404, { message: 'Not Found' }); return; }
          sendBytes(res, out.status, out.body, out.contentType);
          return;
        }
        if (service === 'git-upload-pack' && method === 'POST') {
          const out = handleUploadPack(repo, raw, protocol2);
          if (out.status === 404) { sendJson(res, 404, { message: 'Not Found' }); return; }
          sendBytes(res, out.status, out.body, out.contentType);
          return;
        }
        if (service === 'git-receive-pack' && method === 'POST') {
          const out = handleReceivePack(repo, raw);
          if (out.status === 404) { sendJson(res, 404, { message: 'Not Found' }); return; }
          sendBytes(res, out.status, out.body, out.contentType);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    })().catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch { /* socket already gone */ }
    });
  });
}
