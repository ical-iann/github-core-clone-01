// Shared git object model: hashing, parsing, packfiles, pkt-lines, reachability.
// Node 22 stdlib only. No dependencies.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const AGENT = 'makefun-forge/1.0';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// Object parsing
// ---------------------------------------------------------------------------

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(i, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagParts {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildCommit(opts: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.author} ${opts.timestamp} +0000`);
  lines.push(`committer ${opts.committer} ${opts.timestamp} +0000`);
  const head = lines.join('\n') + '\n\n';
  const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(message, 'utf8')]);
}

export function buildTag(opts: {
  object: string;
  type: string;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}): Buffer {
  const head =
    `object ${opts.object}\ntype ${opts.type}\ntag ${opts.tag}\n` +
    `tagger ${opts.tagger} ${opts.timestamp} +0000\n\n`;
  const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(message, 'utf8')]);
}

/** Build nested trees from a flat path -> {mode, oid} map; stores every tree object. */
export function buildTreesFromPaths(
  files: Map<string, { mode: string; oid: string }>,
  put: (type: ObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      let child = node.dirs.get(segments[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segments[i], child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** Flatten a tree (by oid) to path -> {mode, oid} using a lookup. */
export function flattenTree(
  treeOid: string,
  lookup: (oid: string) => GitObject | undefined,
  prefix = '',
  out: Map<string, { mode: string; oid: string }> = new Map(),
): Map<string, { mode: string; oid: string }> {
  const obj = lookup(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(entry.oid, lookup, path, out);
    else if (entry.mode !== '160000') out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** All objects reachable from the given roots (commits, trees, tags, blobs). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !isObjectId(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal). */
export function isAncestor(
  ancestor: string,
  tip: string,
  lookup: (oid: string) => GitObject | undefined,
): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const stack: string[] = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/** First common ancestor of two commits (BFS from both sides, first-parent aware). */
export function mergeBase(
  a: string,
  b: string,
  lookup: (oid: string) => GitObject | undefined,
): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  let headA = 0;
  while (headA < queueA.length) {
    const oid = queueA[headA++]!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = lookup(oid);
    if (obj?.type === 'commit') queueA.push(...parseCommit(obj.data).parents);
  }
  const queueB: string[] = [b];
  let headB = 0;
  const seenB = new Set<string>();
  while (headB < queueB.length) {
    const oid = queueB[headB++]!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = lookup(oid);
    if (obj?.type === 'commit') queueB.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** Commits reachable from `tip` in newest-first order (BFS by generation, parents after). */
export function commitList(
  tip: string,
  lookup: (oid: string) => GitObject | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++]!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  return out;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface ParsedPackets {
  lines: string[];
  rest: Buffer;
}

/** Parse as many pkt-lines as possible from the front of `buf`. */
export function readPackets(buf: Buffer): ParsedPackets {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      lines.push('\0FLUSH\0');
      offset += 4;
      continue;
    }
    if (len === 1) {
      lines.push('\0DELIM\0');
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) break;
    lines.push(buf.subarray(offset + 4, offset + len).toString('utf8'));
    offset += len;
  }
  return { lines, rest: buf.subarray(offset) };
}

/** Split a byte stream into sideband (band, payload) chunks. Band 1 = data. */
export function readSideband(buf: Buffer): { band: number; data: Buffer }[] {
  const chunks: { band: number; data: Buffer }[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len === 0) break;
    if (len < 5 || offset + len > buf.length) break;
    const payload = buf.subarray(offset + 4, offset + len);
    chunks.push({ band: payload[0], data: Buffer.from(payload.subarray(1)) });
    offset += len;
  }
  return chunks;
}

/** Frame `data` as sideband band-1 packets. A pkt-line is at most 65520 bytes
 *  in total, so each packet carries at most 65515 data bytes (plus the band
 *  byte and the 4-byte length). */
export function sidebandFrame(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  if (data.length === 0) return Buffer.alloc(0);
  while (offset < data.length) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + 65515));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(pktLine(payload));
    offset += chunk.length;
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Packfiles (plain objects; deltas resolved on read)
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const header = Buffer.alloc(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(objects.length, 4);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const size = obj.data.length;
    const headBytes: number[] = [];
    let s = size;
    let first = (typeCode << 4) | (s & 0x0f);
    s >>= 4;
    if (s) first |= 0x80;
    headBytes.push(first);
    while (s) {
      let b = s & 0x7f;
      s >>= 7;
      if (s) b |= 0x80;
      headBytes.push(b);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface PackEntry {
  type: ObjectType;
  data: Buffer;
  oid: string;
  deltaCount: number;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
}

/** Apply a git delta (copy/insert instructions) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (offset < delta.length) {
      const b = delta[offset++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  readVarint(); // base size (unchecked)
  readVarint(); // result size (unchecked)
  const parts: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) copyOffset |= delta[offset++] << (i * 8);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) copySize |= delta[offset++] << (i * 8);
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  return Buffer.concat(parts);
}

/**
 * Read a packfile. `baseLookup` resolves REF_DELTA bases and OFS_DELTA bases that
 * are not inside this pack (used on push, where the base may already be stored).
 */
export function readPack(
  buf: Buffer,
  baseLookup?: (oid: string) => GitObject | undefined,
): ReadPackResult {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const expectedTrailer = buf.subarray(buf.length - 20).toString('hex');
  const actualTrailer = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack checksum mismatch');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: ObjectType; data: Buffer; oid: string }>();
  let deltaCount = 0;
  let offset = 12;
  const pendingDeltas: {
    offset: number;
    baseOffset?: number;
    baseOid?: string;
    delta: Buffer;
    oid: string;
  }[] = [];

  for (let i = 0; i < count; i++) {
    const entryOffset = offset;
    let byte = buf[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA
      let b = buf[offset++];
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset++];
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const base = entryOffset - baseOffset;
      const { data: inflated, consumed } = inflateAt(buf, offset);
      offset += consumed;
      pendingDeltas.push({ offset: entryOffset, baseOffset: base, delta: inflated, oid: '' });
      deltaCount++;
    } else if (typeCode === 7) {
      // REF_DELTA
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: inflated, consumed } = inflateAt(buf, offset);
      offset += consumed;
      pendingDeltas.push({ offset: entryOffset, baseOid, delta: inflated, oid: '' });
      deltaCount++;
    } else {
      const type = PACK_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const { data: inflated, consumed } = inflateAt(buf, offset);
      if (inflated.length !== size) throw new Error('object size mismatch in pack');
      offset += consumed;
      const oid = hashObject(type, inflated);
      objects.set(oid, { type, data: inflated });
      byOffset.set(entryOffset, { type, data: inflated, oid });
    }
  }

  // Resolve deltas (possibly chained, in either order).
  const resolveDelta = (entry: {
    offset: number;
    baseOffset?: number;
    baseOid?: string;
    delta: Buffer;
    oid: string;
  }): { type: ObjectType; data: Buffer; oid: string } => {
    let base: { type: ObjectType; data: Buffer; oid: string } | undefined;
    if (entry.baseOffset !== undefined) {
      base = byOffset.get(entry.baseOffset);
      if (!base) {
        const pending = pendingDeltas.find((p) => p.offset === entry.baseOffset);
        if (pending) base = resolveDelta(pending);
      }
    } else if (entry.baseOid !== undefined) {
      const stored = objects.get(entry.baseOid);
      if (stored) base = { ...stored, oid: entry.baseOid };
      else if (baseLookup) {
        const found = baseLookup(entry.baseOid);
        if (found) base = { ...found, oid: entry.baseOid };
      }
      if (!base) {
        const pending = pendingDeltas.find((p) => p.oid === entry.baseOid);
        if (pending) base = resolveDelta(pending);
      }
    }
    if (!base) throw new Error('delta base not found');
    const data = applyDelta(base.data, entry.delta);
    const oid = hashObject(base.type, data);
    const resolved = { type: base.type, data, oid };
    objects.set(oid, { type: base.type, data });
    byOffset.set(entry.offset, resolved);
    entry.oid = oid;
    return resolved;
  };
  for (const entry of pendingDeltas) resolveDelta(entry);

  return { objects, deltaCount, declaredCount: count };
}

/**
 * Inflate the zlib stream starting at `offset` and report how many bytes it
 * consumed. One `inflateSync` over the tail is enough: with `{ info: true }`
 * the engine reports how many input bytes the stream consumed
 * (`bytesWritten`), so the stream end is known without probing. A result
 * that does not look like a consumed prefix falls back to the binary search
 * below, so a Node build that ever reports the count differently still reads
 * packs correctly (just slower).
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  try {
    const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine?: { bytesWritten?: unknown };
    };
    const consumed = result.engine?.bytesWritten;
    if (
      typeof consumed === 'number' &&
      Number.isInteger(consumed) &&
      consumed > 0 &&
      offset + consumed <= buf.length &&
      result.buffer.length >= 0
    ) {
      return { data: result.buffer, consumed };
    }
  } catch {
    // The stream is truncated or malformed: the search below throws the
    // precise error for it.
  }
  // Fallback: `inflateSync` ignores trailing bytes but throws on a truncated
  // stream, so the predicate "prefix inflates" is monotonic in the prefix
  // length and a binary search finds the exact stream end in O(log n) probes.
  const tryEnd = Math.min(buf.length, offset + 256);
  try {
    inflateSync(buf.subarray(offset, tryEnd));
    let lo = offset;
    let hi = tryEnd;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      try {
        inflateSync(buf.subarray(offset, mid));
        hi = mid;
      } catch {
        lo = mid;
      }
    }
    return { data: inflateSync(buf.subarray(offset, hi)), consumed: hi - offset };
  } catch {
    // The stream is longer than the window (or truncated): search the tail.
  }
  let lo = offset; // known to fail (or equal to offset)
  let hi = buf.length; // must succeed, else the stream is unterminated
  try {
    inflateSync(buf.subarray(offset, hi));
  } catch {
    throw new Error('unterminated deflate stream in pack');
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(buf.subarray(offset, hi)), consumed: hi - offset };
}
