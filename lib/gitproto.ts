// Git smart HTTP: protocol v2 and v0 upload-pack, v0 receive-pack.
// Shares the object store with REST/GraphQL/MCP, so pushed objects are
// immediately visible to every other surface.
import type { ServerResponse } from 'node:http';
import {
  VIEWER,
  findRepo,
  getObject,
  nextTimestamp,
  putObject,
  type Repo,
} from './store.ts';
import {
  AGENT,
  DELIM,
  FLUSH,
  ZERO_OID,
  collectReachable,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPackets,
  readPack,
  sidebandFrame,
  writePack,
  type GitObject,
} from './gitcore.ts';
import {
  isAuthenticated,
  sendBytes,
  sendText,
  type Ctx,
} from './http.ts';

const UPLOAD_CAPS_V0 =
  `side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

interface RefEntry {
  name: string;
  oid: string;
}

function sortedRefs(repo: Repo): RefEntry[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** Peel an annotated tag to its target commit (one level is enough here). */
function peel(oid: string): string {
  const obj = getObject(oid);
  if (obj?.type === 'tag') return parseTag(obj.data).object;
  return oid;
}

function isTagObject(oid: string): boolean {
  return getObject(oid)?.type === 'tag';
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function v0Advertisement(
  service: 'git-upload-pack' | 'git-receive-pack',
  repo: Repo,
): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = defaultTip(repo) ?? refs[0].oid;
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (isTagObject(ref.oid)) {
        parts.push(pktLine(`${peel(ref.oid)} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(repo: Repo): Buffer {
  void repo;
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

function lsRefsV2(repo: Repo, lines: string[]): Buffer {
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).trim());
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const parts: Buffer[] = [];
  const tip = defaultTip(repo);
  if (keep('HEAD')) {
    // HEAD is always listed, with the zero oid while the default branch is
    // unborn. (An `unborn <ref>` line would be counted as a real ref.)
    parts.push(pktLine(`${tip ?? ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (isTagObject(ref.oid)) line += ` peeled:${peel(ref.oid)}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch planning (shared by v2 and v0)
// ---------------------------------------------------------------------------

interface FetchPlan {
  deliver: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/**
 * Objects the client already holds: everything reachable from its `have`
 * commits, except that the walk does not cross a shallow boundary commit —
 * the boundary itself and its tree are held, its parents are not.
 */
function heldClosure(haves: string[], shallow: string[]): Set<string> {
  const stop = new Set(shallow);
  const held = new Set<string>();
  const stack: string[] = [...haves];
  while (stack.length) {
    const oid = stack.pop()!;
    if (held.has(oid)) continue;
    const obj = getObject(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const treeOid of collectReachable([commit.tree], getObject)) held.add(treeOid);
      if (!stop.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return held;
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  void repo;
  const limit = depth ?? Number.POSITIVE_INFINITY;

  // Normalize wants: tags peel to their target commit (generation 0); the
  // tag object itself is always delivered.
  const direct = new Map<string, GitObject>();
  const wantCommits: string[] = [];
  for (const want of wants) {
    const obj = getObject(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      direct.set(want, obj);
      const target = parseTag(obj.data).object;
      const targetObj = getObject(target);
      if (targetObj?.type === 'commit') wantCommits.push(target);
      else if (targetObj) direct.set(target, targetObj);
    } else if (obj.type === 'commit') {
      wantCommits.push(want);
    } else {
      direct.set(want, obj);
    }
  }

  // Included commits: BFS from the want commits, generation < depth.
  const included = new Set<string>();
  const queue: { oid: string; gen: number }[] = wantCommits.map((oid) => ({ oid, gen: 0 }));
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (included.has(oid) || gen >= limit) continue;
    const obj = getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    included.add(oid);
    for (const parent of parseCommit(obj.data).parents) {
      queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  // Everything reachable from the haves is already held: never re-send it.
  // The walk stops at the client's shallow boundaries — a shallow clone
  // holds the boundary commit and its tree, but not the boundary's parents.
  const haveClosure = heldClosure(haves, clientShallow);

  // Deliver: included commits + their full tree closure + direct objects,
  // minus anything the client already holds.
  const deliver = new Map<string, GitObject>();
  for (const [oid, obj] of direct) {
    if (!haveClosure.has(oid)) deliver.set(oid, obj);
  }
  for (const oid of included) {
    if (haveClosure.has(oid)) continue;
    const obj = getObject(oid);
    if (obj) deliver.set(oid, obj);
    const commit = obj ? parseCommit(obj.data) : null;
    if (!commit) continue;
    const treeClosure = collectReachable([commit.tree], getObject);
    for (const treeOid of treeClosure) {
      if (haveClosure.has(treeOid)) continue;
      const treeObj = getObject(treeOid);
      if (treeObj) deliver.set(treeOid, treeObj);
    }
  }

  // Shallow boundaries: included commits with a parent outside the set,
  // plus old client boundaries whose parents are still outside.
  const shallow = new Set<string>();
  for (const oid of included) {
    const obj = getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((parent) => !included.has(parent))) {
      shallow.add(oid);
    }
  }
  const parentsOf = (oid: string): string[] => {
    const obj = getObject(oid);
    return obj?.type === 'commit' ? parseCommit(obj.data).parents : [];
  };
  for (const boundary of clientShallow) {
    if (included.has(boundary)) continue;
    const parents = parentsOf(boundary);
    if (parents.length > 0 && parents.some((parent) => !included.has(parent))) {
      shallow.add(boundary);
    }
  }

  // Unshallow: old boundaries whose parents are now fully included.
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    const parents = parentsOf(boundary);
    if (parents.length === 0) continue;
    if (parents.every((parent) => included.has(parent))) unshallow.push(boundary);
  }

  // Acknowledgements: haves that are common with the wants.
  const acks: string[] = [];
  for (const have of haves) {
    if (!getObject(have)) continue;
    if (wantCommits.includes(have)) {
      acks.push(have);
      continue;
    }
    if (wantCommits.some((want) => isAncestor(have, want, getObject))) acks.push(have);
  }

  return { deliver, shallow: [...shallow], unshallow, acks, nak: acks.length === 0 };
}

function fetchResponseV2(plan: FetchPlan, hadHaves: boolean): Buffer {
  const parts: Buffer[] = [];
  // Real git (and the protocol) expects the acknowledgments section only
  // when the request negotiated with 'have' lines; a fresh clone with no
  // haves goes straight to the shallow-info / packfile sections.
  if (hadHaves) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.nak) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  if (plan.deliver.size > 0) {
    const pack = writePack(
      [...plan.deliver.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, obj]) => obj),
    );
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandFrame(pack, 1));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.nak) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.deliver.size > 0) {
    const pack = writePack(
      [...plan.deliver.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, obj]) => obj),
    );
    parts.push(sidebandFrame(pack, 1));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Upload-pack POST dispatch
// ---------------------------------------------------------------------------

function handleUploadPack(res: ServerResponse, ctx: Ctx, repo: Repo): boolean {
  const { lines } = readPackets(ctx.body);
  if (lines.length === 0) {
    sendText(res, ctx, 400, 'Bad Request: expected pkt-lines');
    return true;
  }
  const first = lines[0];
  if (first.startsWith('command=ls-refs')) {
    const body = lsRefsV2(repo, lines.slice(1));
    sendBytes(res, ctx, 200, body, 'application/x-git-upload-pack-result');
    return true;
  }
  if (first.startsWith('command=fetch')) {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
    }
    const plan = planFetch(repo, wants, haves, shallow, depth);
    sendBytes(res, ctx, 200, fetchResponseV2(plan, haves.length > 0), 'application/x-git-upload-pack-result');
    return true;
  }
  if (first.startsWith('want ')) {
    // Protocol v0 fetch: wants (+shallow/deepen), flush, haves, done, flush.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      if (line === '\0FLUSH\0' || line === '\0DELIM\0') continue;
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) {
        const firstSpace = text.indexOf(' ', 5);
        wants.push(firstSpace === -1 ? text.slice(5).trim() : text.slice(5, firstSpace));
      } else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
    }
    const plan = planFetch(repo, wants, haves, shallow, depth);
    sendBytes(res, ctx, 200, fetchResponseV0(plan), 'application/x-git-upload-pack-result');
    return true;
  }
  sendText(res, ctx, 400, 'Bad Request: unknown upload-pack command');
  return true;
}

// ---------------------------------------------------------------------------
// Receive-pack POST
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, ctx: Ctx, repo: Repo): boolean {
  const { lines, rest } = readPackets(ctx.body);
  const commands: PushCommand[] = [];
  let sideband = false;
  let unpackError: string | null = null;

  for (const line of lines) {
    if (line === '\0FLUSH\0' || line === '\0DELIM\0') break;
    const nul = line.indexOf('\0');
    const commandPart = nul === -1 ? line : line.slice(0, nul);
    const capsPart = nul === -1 ? '' : line.slice(nul + 1);
    if (capsPart.includes('side-band-64k')) sideband = true;
    const text = commandPart.replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]) || !isObjectId(parts[1])) {
      sendText(res, ctx, 400, 'Bad Request: bad push command');
      return true;
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }

  // Store the pushed pack (if any) before validating the refs.
  if (rest.length > 0) {
    try {
      const read = readPack(rest, getObject);
      for (const [oid, obj] of read.objects) {
        if (!getObject(oid)) putObject(obj.type, obj.data);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack error';
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    if (unpackError) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack error' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === null) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    if (!getObject(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== null) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    // Update: old must match the current tip and the new tip must descend from it.
    if (current === null) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
    } else if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (command.newOid !== command.oldOid && !isAncestor(command.oldOid, command.newOid, getObject)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true });
    }
  }
  repo.updatedAt = nextTimestamp();

  const reportLines: Buffer[] = [];
  if (unpackError) {
    reportLines.push(pktLine(`unpack ${unpackError}\n`));
  } else {
    reportLines.push(pktLine('unpack ok\n'));
  }
  for (const result of results) {
    reportLines.push(
      pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`),
    );
  }
  const report = Buffer.concat(reportLines);
  // The report-status stream itself ends with a flush packet inside the
  // sideband data (real git reads the demuxed report until that flush; an
  // EOF before it is "the remote end hung up"), followed by the outer flush
  // that terminates the sideband framing.
  const body = sideband
    ? Buffer.concat([sidebandFrame(Buffer.concat([report, FLUSH]), 1), FLUSH])
    : Buffer.concat([report, FLUSH]);
  sendBytes(res, ctx, 200, body, 'application/x-git-receive-pack-result');
  return true;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleGit(res: ServerResponse, ctx: Ctx): boolean {
  const s = ctx.segments;
  if (s.length < 2 || !s[1].endsWith('.git')) return false;
  const owner = s[0];
  const repoName = s[1].slice(0, -'.git'.length);

  if (!isAuthenticated(ctx)) {
    sendText(res, ctx, 401, 'Requires authentication');
    return true;
  }
  if (owner !== VIEWER.login) {
    sendText(res, ctx, 404, 'Not Found');
    return true;
  }
  const repo = findRepo(owner, repoName);
  if (!repo) {
    sendText(res, ctx, 404, 'Not Found');
    return true;
  }

  const tail = s.slice(2);
  if (ctx.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = ctx.query.get('service');
    if (service === 'git-upload-pack') {
      const v2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
      const body = v2 ? v2Advertisement(repo) : v0Advertisement('git-upload-pack', repo);
      sendBytes(res, ctx, 200, body, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBytes(res, ctx, 200, v0Advertisement('git-receive-pack', repo), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendText(res, ctx, 404, 'Not Found');
    return true;
  }
  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    return handleUploadPack(res, ctx, repo);
  }
  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    return handleReceivePack(res, ctx, repo);
  }
  sendText(res, ctx, 404, 'Not Found');
  return true;
}
