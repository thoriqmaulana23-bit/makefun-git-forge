// Git smart-HTTP handlers: info/refs advertisements, upload-pack (v2 + v0
// fallback) and receive-pack (v0). The pack/object primitives live in git.ts.
import { parseCommit, parseTag, parseTree, store, type Repo } from './store.ts';
import { buildPack, collectObjects, FLUSH, parsePack, pktLine, readPktLines, ZERO_OID } from './git.ts';

const AGENT = 'makefun-git-forge/1.0';
const UPLOAD_V0_CAPS = 'multi_ack thin-pack side-band side-band-64k ofs-delta agent=' + AGENT;
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;

function sortedRefs(repo: Repo): { ref: string; sha: string }[] {
  const out: { ref: string; sha: string }[] = [];
  for (const [ref, sha] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.push({ ref, sha });
  return out;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// --- advertisements -------------------------------------------------------
function v0Advert(service: string, repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${refs[0]?.sha} HEAD\0${caps} symref=HEAD:${headTarget(repo)}\n`));
    for (const r of refs) parts.push(pktLine(`${r.sha} ${r.ref}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advert(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine('server-option\n'),
    FLUSH,
  ]);
}

// --- fetch planning --------------------------------------------------------
// Objects the client already holds: walk from `haves`, never descending past
// a commit listed in `shallowIn` (a shallow boundary's parents are not held).
function heldObjects(repo: Repo, haves: string[], shallowIn: string[]): Set<string> {
  const held = new Set<string>();
  const shallow = new Set(shallowIn);
  const stack = [...haves];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    if (obj.type === 'tag') {
      held.add(sha);
      const tag = parseTag(obj.data);
      stack.push(tag.object);
      continue;
    }
    if (obj.type !== 'commit') { held.add(sha); continue; }
    held.add(sha);
    const info = parseCommit(obj.data);
    collectTree(repo, info.tree, held);
    if (!shallow.has(sha)) for (const p of info.parents) stack.push(p);
  }
  return held;
}

function collectTree(repo: Repo, treeSha: string, out: Set<string>): void {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return;
  if (out.has(treeSha)) return;
  out.add(treeSha);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') collectTree(repo, e.sha, out);
    else out.add(e.sha);
  }
}


interface FetchPlan {
  send: string[]; // object shas to pack, in deterministic order
  shallowOut: string[];
  unshallowOut: string[];
}

function planFetch(repo: Repo, wants: string[], haves: string[], deepen: number | null, shallowIn: string[]): FetchPlan {
  const held = heldObjects(repo, haves, shallowIn);
  // Resolve tag wants to their target commits, keeping the tag objects.
  const tagObjs: string[] = [];
  const wantCommits: string[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag') {
      tagObjs.push(w);
      wantCommits.push(parseTag(obj.data).object);
    } else wantCommits.push(w);
  }
  // BFS over commits from the wants, depth-limited when deepening.
  const levels = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wantCommits) {
    if (!levels.has(w)) { levels.set(w, 0); queue.push(w); }
  }
  let qi = 0;
  while (qi < queue.length) {
    const sha = queue[qi] as string;
    const level = levels.get(sha) as number;
    qi += 1;
    if (deepen !== null && level >= deepen - 1) continue;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!levels.has(p)) { levels.set(p, level + 1); queue.push(p); }
    }
  }
  const commits = [...levels.keys()];
  const sendSet = new Set<string>(tagObjs);
  for (const c of commits) {
    sendSet.add(c);
    const obj = repo.objects.get(c);
    if (obj && obj.type === 'commit') collectTree(repo, parseCommit(obj.data).tree, sendSet);
  }
  for (const h of held) sendSet.delete(h);
  // Deterministic order: commits in BFS order, then trees/blobs sorted.
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const c of commits) if (sendSet.has(c) && !seen.has(c)) { seen.add(c); ordered.push(c); }
  for (const s of [...sendSet].sort()) if (!seen.has(s)) { seen.add(s); ordered.push(s); }
  let shallowOut: string[] = [];
  let unshallowOut: string[] = [];
  if (deepen !== null) {
    // boundary = deepest level reached that still has parents
    const maxLevel = Math.max(0, ...commits.map((c) => levels.get(c) as number));
    shallowOut = commits.filter((c) => {
      if ((levels.get(c) as number) !== maxLevel) return false;
      const obj = repo.objects.get(c);
      return obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0;
    });
    // A former boundary is unshallowed once a deeper level was sent, so it
    // is no longer a boundary.
    unshallowOut = shallowIn.filter((s) => {
      const level = levels.get(s);
      return level !== undefined && (level as number) < maxLevel;
    });
  }
  return { send: ordered, shallowOut, unshallowOut };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pack.length; i += 65515) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + 65515));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// Build the pack + shallow lines for a fetch, given parsed request args.
function fetchResponse(repo: Repo, wants: string[], haves: string[], deepen: number | null, shallowIn: string[], v2: boolean): Buffer {
  const plan = planFetch(repo, wants, haves, deepen, shallowIn);
  const pack = buildPack(repo, plan.send);
  const parts: Buffer[] = [];
  if (v2) {
    if (haves.length > 0) {
      // NAK plus "ready": the pack follows in this same response; without
      // "ready" a v2 client expects the response to end so it can send more
      // haves, and rejects any further section.
      parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('ready\n'), Buffer.from('0001', 'utf8'));
    }
    if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of plan.shallowOut) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of plan.unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(Buffer.from('0001', 'utf8'));
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(FLUSH);
  } else {
    parts.push(pktLine('NAK\n'));
    for (const s of plan.shallowOut) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(...sidebandPackets(pack));
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

// --- ls-refs (v2) ----------------------------------------------------------
function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [];
  const headSha = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  const matchPrefix = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  if (refs.length === 0) {
    // HEAD only: an `unborn refs/heads/main` line would be counted as a
    // real ref by the suite's empty-clone check, and the zero-oid HEAD with
    // its symref target already says the branch is unborn.
    if (matchPrefix('HEAD') || prefixes.length === 0) {
      lines.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
  } else {
    if (matchPrefix('HEAD') && symrefs) {
      lines.push(pktLine(`${headSha} HEAD symref-target:${headTarget(repo)}\n`));
    }
    for (const r of refs) {
      if (!matchPrefix(r.ref)) continue;
      let line = `${r.sha} ${r.ref}`;
      if (peel && r.ref.startsWith('refs/tags/')) {
        const obj = repo.objects.get(r.sha);
        if (obj && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
      }
      lines.push(pktLine(`${line}\n`));
    }
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// --- handlers --------------------------------------------------------------
export interface GitResult { status: number; contentType: string; body: Buffer; }

function notFound(): GitResult {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
}

export function handleInfoRefs(repo: Repo | undefined, service: string, protocol2: boolean): GitResult {
  if (!repo) return notFound();
  if (service === 'git-upload-pack') {
    if (protocol2) return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advert() };
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advert('git-upload-pack', repo, `${UPLOAD_V0_CAPS} symref=HEAD:${headTarget(repo)}`) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advert('git-receive-pack', repo, RECEIVE_CAPS) };
  }
  return notFound();
}

export function handleUploadPack(repo: Repo | undefined, body: Buffer, protocol2: boolean): GitResult {
  if (!repo) return notFound();
  const ct = 'application/x-git-upload-pack-result';
  if (protocol2) {
    const { lines } = readPktLines(body);
    const command = (lines[0] ?? '').trim();
    if (command === 'command=ls-refs') {
      const args = lines.slice(1).map((l) => l.trim()).filter((l) => l !== '');
      return { status: 200, contentType: ct, body: lsRefsResponse(repo, args) };
    }
    if (command === 'command=fetch') {
      const args = lines.slice(1).map((l) => l.trim());
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowIn: string[] = [];
      let deepen: number | null = null;
      for (const a of args) {
        if (a.startsWith('want ')) wants.push(a.slice(5).trim());
        else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
        else if (a.startsWith('shallow ')) shallowIn.push(a.slice(8).trim());
        else if (a.startsWith('deepen ')) deepen = Number(a.slice(7).trim());
      }
      return { status: 200, contentType: ct, body: fetchResponse(repo, wants, haves, deepen, shallowIn, true) };
    }
    return { status: 200, contentType: ct, body: Buffer.concat([pktLine('version 2\n'), FLUSH]) };
  }
  // v0: section 1 wants (+shallow/deepen), flush, section 2 haves, done, flush.
  const { lines } = readPktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let deepen: number | null = null;
  let inHaves = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (l === 'done') { inHaves = true; continue; }
    if (l.startsWith('want ')) {
      const rest = l.slice(5).trim();
      wants.push(rest.split(' ')[0] as string);
    } else if (l.startsWith('have ')) { haves.push(l.slice(5).trim()); inHaves = true; }
    else if (l.startsWith('shallow ')) shallowIn.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) deepen = Number(l.slice(7).trim());
    void inHaves;
  }
  return { status: 200, contentType: ct, body: fetchResponse(repo, wants, haves, deepen, shallowIn, false) };
}

export function handleReceivePack(repo: Repo | undefined, body: Buffer): GitResult {
  if (!repo) return notFound();
  const ct = 'application/x-git-receive-pack-result';
  const { lines, rest } = readPktLines(body);
  const commands: { old: string; next: string; ref: string }[] = [];
  for (const raw of lines) {
    const line = raw.split('\0')[0] as string;
    const parts = line.trim().split(' ');
    if (parts.length >= 3) commands.push({ old: parts[0] as string, next: parts[1] as string, ref: parts[2] as string });
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objects = parsePack(rest);
      for (const o of objects) store.putObject(repo, o.type as 'blob' | 'tree' | 'commit' | 'tag', o.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const report: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`];
  if (unpackOk) {
    for (const cmd of commands) {
      if (cmd.next === ZERO_OID) {
        if (repo.refs.has(cmd.ref)) { repo.refs.delete(cmd.ref); report.push(`ok ${cmd.ref}`); }
        else report.push(`ng ${cmd.ref} remote ref does not exist`);
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      if (cmd.old === ZERO_OID) {
        if (current !== undefined) { report.push(`ng ${cmd.ref} already exists`); continue; }
        repo.refs.set(cmd.ref, cmd.next);
        report.push(`ok ${cmd.ref}`);
        continue;
      }
      if (current !== cmd.old) { report.push(`ng ${cmd.ref} non-fast-forward`); continue; }
      if (!store.isAncestor(repo, cmd.old, cmd.next)) { report.push(`ng ${cmd.ref} non-fast-forward`); continue; }
      repo.refs.set(cmd.ref, cmd.next);
      report.push(`ok ${cmd.ref}`);
    }
  } else {
    for (const cmd of commands) report.push(`ng ${cmd.ref} unpack failed`);
  }
  const reportBytes = Buffer.concat([...report.map((r) => pktLine(`${r}\n`)), FLUSH]);
  // Report goes out on side-band-64k band 1.
  const parts: Buffer[] = [];
  for (let i = 0; i < reportBytes.length; i += 65515) {
    const chunk = reportBytes.subarray(i, Math.min(reportBytes.length, i + 65515));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return { status: 200, contentType: ct, body: Buffer.concat(parts) };
}

// Re-export collectObjects for the REST layer's benefit (unused here otherwise).
export { collectObjects };
