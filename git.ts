// The git object machinery and the smart-HTTP protocol, with no git binary: SHA-1 object ids via
// node:crypto, zlib via node:zlib, packfiles read and written by hand. Objects pushed over the
// wire are stored byte-for-byte (a commit pushed by a client reads back byte-exact); objects the
// REST surface creates are built with the same writers, so all four surfaces share one store.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, RepoRec } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 object id of a typed payload: sha1("<type> <length>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object (deduplicated by id) and answer its id. */
export function storeObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getCommit(repo: RepoRec, oid: string): GitObject | null {
  const object = repo.objects.get(oid);
  return object !== undefined && object.type === 'commit' ? object : null;
}

/** Peel an oid through annotated tags to the commit it names; null when it names no commit. */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const target = parseTag(object.data);
    if (target === null) return null;
    current = target;
  }
  return null;
}

/** The commit an oid names after peeling tags; the object itself when it already is a commit. */
export function peelTagOnce(repo: RepoRec, oid: string): { target: string } | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const target = parseTag(object.data);
  return target === null ? null : { target };
}

/** An annotated tag object's target oid (the `object` header). */
export function parseTag(data: Buffer): string | null {
  const head = data.toString('utf8', 0, Math.min(data.length, 4096));
  for (const line of head.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return null;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorTime: number;
}

/** Parse a commit object: tree, parents in order, the message after the blank line, author time. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const head = splitAt === -1 ? text : text.slice(0, splitAt);
  const message = splitAt === -1 ? '' : text.slice(splitAt + 2);
  let tree = '';
  let authorTime = 0;
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = / ([0-9]+) [+-][0-9]{4}$/.exec(line);
      if (match !== null) authorTime = Number(match[1]);
    }
  }
  return { tree, parents, message, authorTime };
}

/** Build a commit object's bytes with one identity for author and committer. */
export function buildCommitData(options: {
  tree: string;
  parents: readonly string[];
  message: string;
  name: string;
  email: string;
  time: number;
}): Buffer {
  const ident = `${options.name} <${options.email}> ${options.time} +0000`;
  let head = `tree ${options.tree}\n`;
  for (const parent of options.parents) head += `parent ${parent}\n`;
  head += `author ${ident}\ncommitter ${ident}\n`;
  return Buffer.from(`${head}\n${options.message}`, 'utf8');
}

export interface TreeEntry {
  /** '40000' for a directory, '100644'/'100755'/'120000' for a leaf, as stored on the wire. */
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: bytewise by name, directories compared as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Store a tree built from entries; answers the tree oid (the empty tree for no entries). */
export function storeTree(repo: RepoRec, entries: readonly TreeEntry[]): string {
  if (entries.length === 0) {
    if (!repo.objects.has(EMPTY_TREE_OID)) repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
    return EMPTY_TREE_OID;
  }
  return storeObject(repo, 'tree', buildTreeData(entries));
}

/** The entry at one path segment inside a tree, or null. */
function treeEntry(repo: RepoRec, treeOid: string, name: string): TreeEntry | null {
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return null;
  for (const entry of parseTree(tree.data)) if (entry.name === name) return entry;
  return null;
}

/** Walk a '/'-separated path from a root tree to the blob or tree it names. */
export function lookupPath(repo: RepoRec, rootTreeOid: string, path: string): { kind: 'blob' | 'tree'; oid: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = rootTreeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const entry = treeEntry(repo, current, segments[index] as string);
    if (entry === null) return null;
    if (index === segments.length - 1) return { kind: entry.mode === '40000' ? 'tree' : 'blob', oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { kind: 'tree', oid: rootTreeOid };
}

/** Every blob under a tree, as a path -> blob oid map (paths '/'-joined). */
export function flattenTree(repo: RepoRec, rootTreeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(rootTreeOid, '');
  return out;
}

/** Build (and store) the nested trees for a flat path -> blob oid map; answers the root tree oid. */
export function storeTreeFromFlat(repo: RepoRec, files: ReadonlyMap<string, string>): string {
  const build = (entries: ReadonlyMap<string, string>): string => {
    const direct: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, string>>();
    for (const [path, oid] of entries) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        direct.push({ mode: '100644', name: path, oid });
      } else {
        const dir = path.slice(0, slash);
        let bucket = subdirs.get(dir);
        if (bucket === undefined) {
          bucket = new Map();
          subdirs.set(dir, bucket);
        }
        bucket.set(path.slice(slash + 1), oid);
      }
    }
    for (const [dir, bucket] of subdirs) direct.push({ mode: '40000', name: dir, oid: build(bucket) });
    return storeTree(repo, direct);
  };
  return build(files);
}

/** The tree oid of a commit, or null when the commit is unknown. */
export function commitTree(repo: RepoRec, commitOid: string): string | null {
  const commit = getCommit(repo, commitOid);
  if (commit === null) return null;
  return parseCommit(commit.data).tree;
}

/** Every ancestor of a commit (itself included), breadth-first; unknown oids are skipped. */
export function ancestorSet(repo: RepoRec, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    seen.add(oid);
    for (const parent of parseCommit(commit.data).parents) queue.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors (the fast-forward test). */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    for (const parent of parseCommit(commit.data).parents) queue.push(parent);
  }
  return false;
}

/** A common ancestor of two commits (nearest to `b` first), or null for unrelated histories. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(repo, a);
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    for (const parent of parseCommit(commit.data).parents) queue.push(parent);
  }
  return null;
}

/** Add a commit's tree closure (trees and blobs, recursively) to `into`. */
function addTreeClosure(repo: RepoRec, treeOid: string, into: Map<string, GitObject>): void {
  if (into.has(treeOid)) return;
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  into.set(treeOid, tree);
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') {
      addTreeClosure(repo, entry.oid, into);
    } else {
      const blob = repo.objects.get(entry.oid);
      if (blob !== undefined && !into.has(entry.oid)) into.set(entry.oid, blob);
    }
  }
}

/** The full object closure of a set of commits: the commits plus every tree and blob they reach. */
export function objectClosure(repo: RepoRec, commits: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  for (const oid of commits) {
    const commit = getCommit(repo, oid);
    if (commit === null || out.has(oid)) continue;
    out.set(oid, commit);
    addTreeClosure(repo, parseCommit(commit.data).tree, out);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Packfiles

/** One object to write into a pack. */
export interface PackInput {
  type: GitObjectType;
  data: Buffer;
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest >>= 4;
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (never delta) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly PackInput[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    // Level 1: a pack cares about the trailer and the object hashes, not the ratio, and the
    // fetch hot path (50 concurrent depth-1 clones) deflates three small objects per request.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate the stream starting at `offset`, answering the data and the offset just past its end.
 * A zlib stream knows where its input ended: fed the rest of the pack, it stops at its own final
 * block and reports the consumed byte count as `bytesWritten` — one stream per object replaces a
 * search over candidate ends (inflateSync cannot report where a stream stopped). A truncated or
 * corrupt stream errors the promise, which readPack turns into a throw.
 */
function inflateAt(buf: Buffer, offset: number, expectedSize: number): Promise<{ data: Buffer; next: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const data = Buffer.concat(chunks);
      if (data.length !== expectedSize) {
        reject(new Error('pack object inflated to the wrong size'));
        return;
      }
      resolve({ data, next: offset + stream.bytesWritten });
    });
    stream.on('error', reject);
    stream.end(buf.subarray(offset));
  });
}

/** Apply a git delta (copy/insert instructions) to a base payload. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) { offset |= (delta[pos] as number) << (8 * bit); pos += 1; }
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) { size |= (delta[pos] as number) << (8 * bit); pos += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

interface PendingDelta {
  /** REF_DELTA: the base's object id (which may live in this pack or in the repository). */
  baseOid: string | null;
  /** OFS_DELTA: the pack index of the base object. */
  baseIndex: number | null;
  /** This delta object's own pack index, so later OFS_DELTAs can rest on it. */
  index: number;
  delta: Buffer;
}

/**
 * Read the pack starting at `offset` in `buf`, resolving plain and delta objects (deltas may chain
 * and may rest on objects the repository already holds — a thin pack). Answers the resolved objects
 * (not yet stored). Throws on any malformation; callers keep the server up.
 */
export async function readPack(repo: RepoRec, buf: Buffer, offset: number): Promise<PackInput[]> {
  if (buf.length - offset < 12 || buf.toString('ascii', offset, offset + 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(offset + 8);
  let pos = offset + 12;
  const startToIndex = new Map<number, number>();
  const byIndex = new Map<number, { oid: string; type: GitObjectType; data: Buffer }>();
  const resolved = new Map<string, { type: GitObjectType; data: Buffer }>();
  const pending: PendingDelta[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = pos;
    startToIndex.set(start, index);
    let byte = buf[pos] as number;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a varint encoding the distance from this object's start back to its base's start.
      let back = buf[pos] as number;
      pos += 1;
      let baseOffset = back & 0x7f;
      while (back & 0x80) {
        back = buf[pos] as number;
        pos += 1;
        baseOffset = ((baseOffset + 1) << 7) | (back & 0x7f);
      }
      const baseIndex = startToIndex.get(start - baseOffset);
      if (baseIndex === undefined) throw new Error('ofs-delta base outside the pack');
      const { data, next } = await inflateAt(buf, pos, size);
      pos = next;
      pending.push({ baseOid: null, baseIndex, index, delta: data });
    } else if (typeCode === 7) {
      const baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
      const { data, next } = await inflateAt(buf, pos, size);
      pos = next;
      pending.push({ baseOid, baseIndex: null, index, delta: data });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next } = await inflateAt(buf, pos, size);
      pos = next;
      const oid = hashObject(type, data);
      const record = { oid, type, data };
      byIndex.set(index, record);
      resolved.set(oid, { type, data });
    }
  }
  // Resolve deltas in dependency order; a delta's result registers under its own pack index so a
  // later OFS_DELTA chained on it finds its base.
  let remaining = [...pending];
  let guard = remaining.length * remaining.length + 16;
  while (remaining.length > 0 && guard > 0) {
    guard -= 1;
    const deferred: PendingDelta[] = [];
    for (const item of remaining) {
      let base: { type: GitObjectType; data: Buffer } | undefined;
      if (item.baseOid !== null) {
        base = resolved.get(item.baseOid) ?? repo.objects.get(item.baseOid);
      } else if (item.baseIndex !== null) {
        const record = byIndex.get(item.baseIndex);
        if (record !== undefined) base = { type: record.type, data: record.data };
      }
      if (base === undefined) {
        deferred.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.delta);
      const oid = hashObject(base.type, data);
      resolved.set(oid, { type: base.type, data });
      byIndex.set(item.index, { oid, type: base.type, data });
    }
    if (deferred.length === remaining.length) break;
    remaining = deferred;
  }
  if (remaining.length > 0) throw new Error('pack deltas do not resolve');
  return [...resolved.values()].map((record) => ({ type: record.type, data: record.data }));
}

// ------------------------------------------------------------------------------------------------
// pkt-lines

/** One framed packet: `<4 hex length><payload>`; the length counts itself. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  data: Buffer;
}

/**
 * Parse pkt-lines from `buf` starting at `offset`, stopping after the first flush (or at the end of
 * the buffer). Answers the packets and the offset just past the last one consumed — receive-pack
 * finds its packfile there. Throws on a malformed length.
 */
export function parsePkts(buf: Buffer, offset = 0): { packets: Pkt[]; next: number } {
  const packets: Pkt[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`malformed pkt-line length "${header}"`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      pos += 4;
      return { packets, next: pos };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) throw new Error('pkt-line overruns the buffer');
    packets.push({ kind: 'data', data: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, next: pos };
}

/** Split a packet payload at the first NUL (the capability list rides after it on first lines). */
export function splitCaps(payload: Buffer): { line: string; caps: string } {
  const nul = payload.indexOf(0x00);
  if (nul === -1) return { line: payload.toString('utf8'), caps: '' };
  return { line: payload.toString('utf8', 0, nul), caps: payload.toString('utf8', nul + 1) };
}

/** Strip one trailing newline, the way protocol lines are written. */
export function chomp(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

// ------------------------------------------------------------------------------------------------
// Fetch object selection

export interface FetchSelection {
  /** The objects to pack, in send order. */
  objects: PackInput[];
  /** Boundary commits the client must newly mark shallow. */
  shallow: string[];
  /** Client-shallow commits that stop being boundary commits. */
  unshallow: string[];
}

/**
 * Choose the objects a fetch sends. The model is git's: everything reachable from the wants, minus
 * everything reachable from the haves (a have the client holds shallow counts as held, its parents
 * do not). A depth cuts the wants' history at that many generations and reports the cut commits as
 * the new shallow boundary; a deepen re-measures the depth from the wants and unshallows the old
 * boundary commits the deeper walk now covers.
 */
export function selectFetchObjects(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: ReadonlySet<string>,
  depth: number | null,
): FetchSelection {
  // The commits the client provably holds: the haves' closure, cut at its shallow boundary.
  const hadCommits = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (hadCommits.has(oid)) continue;
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      hadCommits.add(oid);
      if (clientShallow.has(oid)) continue;
      for (const parent of parseCommit(commit.data).parents) stack.push(parent);
    }
  }
  // Tag objects named directly as wants ride along, peeled to their commits for the walk.
  const extraObjects = new Map<string, GitObject>();
  const wantTips: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      extraObjects.set(want, object);
      const commit = peelToCommit(repo, want);
      if (commit !== null) wantTips.push(commit);
    } else if (object.type === 'commit') {
      wantTips.push(want);
    }
  }
  // The wants' commits, breadth-first by generation.
  const included = new Map<string, number>();
  {
    let frontier = [...new Set(wantTips)];
    let distance = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (included.has(oid)) continue;
        const commit = getCommit(repo, oid);
        if (commit === null) continue;
        included.set(oid, distance);
        if (depth === null && clientShallow.has(oid)) continue;
        for (const parent of parseCommit(commit.data).parents) next.push(parent);
      }
      if (depth !== null && distance + 1 >= depth) break;
      frontier = next;
      distance += 1;
    }
  }
  const sendCommits = new Set<string>();
  for (const oid of included.keys()) if (!hadCommits.has(oid)) sendCommits.add(oid);
  const sendObjects = objectClosure(repo, sendCommits);
  const hadObjects = objectClosure(repo, hadCommits);
  for (const oid of hadObjects.keys()) sendObjects.delete(oid);
  for (const [oid, object] of extraObjects) sendObjects.set(oid, object);
  // Boundary bookkeeping, only meaningful when a depth was in play.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of included.keys()) {
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      const cut = parseCommit(commit.data).parents.some((parent) => !included.has(parent) && getCommit(repo, parent) !== null);
      if (cut) shallow.push(oid);
    }
    for (const oid of clientShallow) {
      if (included.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
    }
  }
  return {
    objects: [...sendObjects.values()].map((object) => ({ type: object.type, data: object.data })),
    shallow,
    unshallow,
  };
}

// ------------------------------------------------------------------------------------------------
// The smart-HTTP wire

export interface WireAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'makefun-forge/1.0';

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 ref advertisement lines (HEAD first, capabilities on the first line, peeled tags after their ref). */
function v0RefLines(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer[] {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:${headRef(repo)} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = sortedRefs(repo);
  if (refs.length === 0) return [pktLine(`${ZERO_OID} capabilities^{}\0${caps}`)];
  const lines: Buffer[] = [];
  const head = headRef(repo);
  const headTip = repo.refs.get(head);
  let first = true;
  if (headTip !== undefined) {
    lines.push(pktLine(`${headTip} HEAD\0${caps}`));
    first = false;
  }
  for (const [ref, oid] of refs) {
    lines.push(pktLine(first ? `${oid} ${ref}\0${caps}` : `${oid} ${ref}`));
    first = false;
    const peeled = peelTagOnce(repo, oid);
    if (peeled !== null) {
      const commit = peelToCommit(repo, oid);
      if (commit !== null) lines.push(pktLine(`${commit} ${ref}^{}`));
    }
  }
  return lines;
}

/** GET info/refs: a v2 capability list for upload-pack when asked, else the v0 advertisement. */
export function infoRefs(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): WireAnswer {
  if (service === 'git-upload-pack' && protocolV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const body = Buffer.concat([pktLine(`# service=${service}\n`), PKT_FLUSH, ...v0RefLines(repo, service), PKT_FLUSH]);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body };
}

/** One ls-refs answer: HEAD (or its unborn form), then the refs, honouring prefixes, peel and symrefs. */
function lsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const head = headRef(repo);
  const headTip = repo.refs.get(head);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      lines.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD symref-target:${head}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const commit = peelToCommit(repo, oid);
      if (commit !== null && commit !== oid) line += ` peeled:${commit}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  return Buffer.concat([...lines, PKT_FLUSH]);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: Set<string>;
  depth: number | null;
  done: boolean;
}

/** Parse the argument block of a v2 fetch (the packets after the capability delimiter). */
function parseFetchArgs(packets: readonly Pkt[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: new Set(), depth: null, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = chomp(packet.data.toString('utf8'));
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

/** Wrap pack bytes in side-band-64k band-1 packets of at most 65516 payload bytes each. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    const chunk = pack.subarray(pos, pos + CHUNK);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

/** A v2 fetch answer: acknowledgments (when haves were offered), shallow-info, then the packfile section. */
function fetchV2(repo: RepoRec, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const acks = args.haves.filter((have) => getCommit(repo, have) !== null && isAncestor(repo, have, args.wants[0] ?? have));
    if (acks.length === 0) parts.push(pktLine('NAK\n'));
    else for (const have of acks) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(PKT_FLUSH);
  }
  if (args.depth !== null || args.shallow.size > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v0 fetch answer: NAK/ACK and shallow lines as plain packets, then the sideband pack. */
function fetchV0(repo: RepoRec, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  const acks = args.haves.filter((have) => getCommit(repo, have) !== null);
  if (acks.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${acks[0]}\n`));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Parse every pkt-line in a buffer (parsePkts stops at each flush; this walks past them). */
function parseAllPkts(buf: Buffer): Pkt[] {
  const all: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const { packets, next } = parsePkts(buf, offset);
    if (next === offset) break;
    all.push(...packets);
    offset = next;
  }
  return all;
}

/** POST git-upload-pack: a v2 ls-refs/fetch command, or a v0 fetch negotiation. Throws on garbage. */
export function uploadPack(repo: RepoRec, body: Buffer, protocolV2: boolean): WireAnswer {
  const packets = parseAllPkts(body);
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(chomp(packet.data.toString('utf8')));
  if (protocolV2) {
    const commandLine = lines.find((line) => line.startsWith('command='));
    const command = commandLine === undefined ? '' : commandLine.slice('command='.length);
    const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimAt === -1 ? [] : packets.slice(delimAt + 1);
    if (command === 'ls-refs') {
      const args = argPackets.filter((packet) => packet.kind === 'data').map((packet) => chomp(packet.data.toString('utf8')));
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
    }
    if (command === 'fetch') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, parseFetchArgs(argPackets)) };
    }
    throw new Error(`unknown v2 command "${command}"`);
  }
  // v0: want lines (the first carries the capabilities), shallow/deepen lines, a flush, haves, done.
  const args: FetchArgs = { wants: [], haves: [], shallow: new Set(), depth: null, done: false };
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const { line } = splitCaps(packet.data);
    const text = chomp(line);
    if (!sawFlush) {
      if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) args.shallow.add(text.slice(8).trim());
      else if (text.startsWith('deepen ')) args.depth = Number(text.slice(7).trim());
    } else {
      if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text === 'done') args.done = true;
    }
  }
  if (args.wants.length === 0) throw new Error('a v0 fetch with no wants');
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, args) };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: unpack, validate each ref update on its own, report per ref. */
export async function receivePack(repo: RepoRec, body: Buffer): Promise<WireAnswer> {
  const { packets, next } = parsePkts(body);
  const commands: PushCommand[] = [];
  let caps = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const split = splitCaps(packet.data);
    if (caps === '' && split.caps !== '') caps = split.caps;
    const parts = chomp(split.line).split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const capSet = new Set(caps.split(' ').filter((cap) => cap !== ''));
  let unpackDetail = 'ok';
  const rest = body.subarray(next);
  if (rest.length >= 12 && rest.toString('ascii', 0, 4) === 'PACK') {
    try {
      for (const object of await readPack(repo, rest, 0)) storeObject(repo, object.type, object.data);
    } catch (err) {
      unpackDetail = err instanceof Error ? err.message : 'index-pack failed';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    results.push({ ref: command.ref, ...applyPushCommand(repo, command, unpackDetail === 'ok') });
  }
  if (!capSet.has('report-status')) return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  const report: Buffer[] = [pktLine(`unpack ${unpackDetail}\n`)];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  report.push(PKT_FLUSH);
  const reportBytes = Buffer.concat(report);
  if (capSet.has('side-band-64k')) {
    const wrapped: Buffer[] = [];
    for (const piece of report) wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
    wrapped.push(PKT_FLUSH);
    void reportBytes;
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(wrapped) };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportBytes };
}

/** Validate and apply one ref update; a refusal names its reason and changes nothing. */
function applyPushCommand(repo: RepoRec, command: PushCommand, unpackOk: boolean): { ok: boolean; reason: string } {
  if (!unpackOk) return { ok: false, reason: 'unpack failed' };
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.oldOid !== current) return { ok: false, reason: 'stale ref' };
  if (command.newOid === ZERO_OID) {
    if (command.ref === headRef(repo)) return { ok: false, reason: 'deletion of the current branch prohibited' };
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  const object = repo.objects.get(command.newOid);
  if (object === undefined) return { ok: false, reason: 'missing object' };
  if (object.type !== 'commit' && object.type !== 'tag') return { ok: false, reason: 'not a commit' };
  if (command.oldOid !== ZERO_OID) {
    const newCommit = peelToCommit(repo, command.newOid);
    const oldCommit = peelToCommit(repo, command.oldOid);
    if (newCommit === null || oldCommit === null || !isAncestor(repo, oldCommit, newCommit)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}
