// Git smart HTTP, implemented on node:zlib / node:crypto only: pkt-line framing,
// packfile generation (full objects, no deltas) and parsing (OFS/REF deltas),
// upload-pack protocol v2 (+ v0 fallback) and receive-pack v0.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseCommit, parseTree, store, type Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

// ---------------------------------------------------------------- pkt-line
export function pktLine(s: string | Buffer): Buffer {
  const payload = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  const len = payload.length + 4;
  const out = Buffer.allocUnsafe(len);
  out.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  payload.copy(out, 4);
  return out;
}
export const FLUSH = Buffer.from('0000', 'utf8');

export interface PktReader { lines: string[]; rest: Buffer; }
export function readPktLines(buf: Buffer): PktReader {
  const lines: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { i += 4; break; } // flush
    if (len === 1) { i += 4; continue; } // delim
    if (i + len > buf.length) break;
    lines.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  return { lines, rest: buf.subarray(i) };
}

// ---------------------------------------------------------------- pack gen
const OBJ_TYPES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) b |= 0x80;
  bytes.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function buildPack(repo: Repo, shas: string[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(shas.length, 8);
  parts.push(head);
  for (const sha of shas) {
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    const typeNum = OBJ_TYPES[obj.type] as number;
    parts.push(packObjectHeader(typeNum, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Collect objects reachable from `wants`, excluding anything reachable from `haves`.
// When depth1 is set, only the tip commits themselves (plus their trees/blobs).
export function collectObjects(repo: Repo, wants: string[], haves: string[], depth1: boolean): string[] {
  const excluded = new Set<string>();
  for (const h of haves) {
    for (const s of store.ancestors(repo, h)) {
      excluded.add(s);
      const o = repo.objects.get(s);
      if (o && o.type === 'commit') collectTreeObjects(repo, parseCommit(o.data).tree, excluded);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (sha: string): void => {
    if (seen.has(sha) || excluded.has(sha)) return;
    seen.add(sha);
    out.push(sha);
  };
  const visitCommit = (sha: string): void => {
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') return;
    add(sha);
    const info = parseCommit(obj.data);
    collectTreeObjects(repo, info.tree, seen, out);
    if (!depth1) for (const p of info.parents) visitCommit(p);
  };
  for (const w of wants) visitCommit(w);
  return out;
}

function collectTreeObjects(repo: Repo, treeSha: string, seen: Set<string>, out?: string[]): void {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return;
  if (seen.has(treeSha)) return;
  seen.add(treeSha);
  if (out) out.push(treeSha);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') collectTreeObjects(repo, e.sha, seen, out);
    else if (!seen.has(e.sha)) { seen.add(e.sha); if (out) out.push(e.sha); }
  }
}

// ---------------------------------------------------------------- pack parse
interface ParsedObject { type: string; data: Buffer; sha: string; }

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVar = (): number => {
    let v = 0; let s = 0;
    while (true) {
      const b = delta[p] as number; p += 1;
      v |= (b & 0x7f) << s; s += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const dstSize = readVar();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p] as number; p += 1;
    if (op & 0x80) {
      let off = 0; let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { off |= (delta[p] as number) << (8 * i); p += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { size |= (delta[p] as number) << (8 * i); p += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      total += size;
    } else if (op > 0) {
      out.push(delta.subarray(p, p + op));
      total += op;
      p += op;
    } else throw new Error('delta op 0');
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta size mismatch');
  return result;
}

export function parsePack(buf: Buffer): ParsedObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  const out: ParsedObject[] = [];
  const byOffset = new Map<number, ParsedObject>();
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const start = pos;
    const first = buf[pos] as number; pos += 1;
    const typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    while ((buf[pos - 1] as number) & 0x80) {
      const b = buf[pos] as number; pos += 1;
      size |= (b & 0x7f) << shift; shift += 7;
    }
    let type: string;
    let data: Buffer;
    if (typeNum === 6) { // OFS_DELTA: git's offset encoding, not plain varint
      let b = buf[pos] as number; pos += 1;
      let negOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos] as number; pos += 1;
        negOff = ((negOff + 1) << 7) | (b & 0x7f);
      }
      const baseOff = start - negOff;
      const inflated = inflateAt(buf, pos);
      pos = inflated.next;
      const base = byOffset.get(baseOff);
      if (!base) throw new Error('ofs-delta base missing');
      data = applyDelta(base.data, inflated.data);
      type = base.type;
    } else if (typeNum === 7) { // REF_DELTA
      const baseSha = buf.subarray(pos, pos + 20).toString('hex'); pos += 20;
      const inflated = inflateAt(buf, pos);
      pos = inflated.next;
      const base = out.find((o) => o.sha === baseSha);
      if (!base) throw new Error('ref-delta base missing');
      data = applyDelta(base.data, inflated.data);
      type = base.type;
    } else {
      type = TYPE_NAMES[typeNum] as string;
      const inflated = inflateAt(buf, pos);
      data = inflated.data;
      pos = inflated.next;
    }
    const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const sha = createHash('sha1').update(head).update(data).digest('hex');
    const obj: ParsedObject = { type, data, sha };
    out.push(obj);
    byOffset.set(start, obj);
  }
  return out;
}

/** Inflate one zlib stream at `pos`; returns its bytes and the offset just past the stream. */
function inflateAt(buf: Buffer, pos: number): { data: Buffer; next: number } {
  // inflateSync(..., { info: true }) reports the input bytes the engine consumed
  // as engine.bytesWritten, so one inflate gives both the data and the stream's
  // length — no binary search over prefixes (which re-inflated ~log2(n) times
  // and threw a stack-capturing error on every too-short prefix).
  const result = inflateSync(buf.subarray(pos), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: pos + written };
}
