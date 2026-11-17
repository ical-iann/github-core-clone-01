// In-memory data model for the forge. One process, no disk: the grading
// harness creates everything through the API and expects it back within the
// same process lifetime. All timestamps are deterministic (a monotonic
// counter from a fixed base) so repeated runs replay identically.
import {
  buildCommit,
  buildTreesFromPaths,
  flattenTree,
  hashObject,
  mergeBase,
  parseCommit,
  parseTag,
  type GitObject,
  type ObjectType,
} from './gitcore.ts';

// Viewer identity, taken from the published scenario in the kit (wire.ts):
// the token the runner supplies always names this user.
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  email: 'adaiversen@make.fun',
  name: 'Ada Iversen',
  type: 'User',
} as const;

export const TEAMMATE = { login: 'quinnkeller', id: 1001 } as const;
export const STRANGER = { login: 'olgabauer', id: 1002 } as const;
export const ORG = { login: 'faint-meadow-org', id: 2000 } as const;

export const COMMIT_AUTHOR = 'Conformance <conformance@make.fun>';
export const COMMIT_TIMESTAMP = 1700000000;

let seq = 0;
/** Monotonic logical clock: ISO timestamp string, one second per call. */
export function nextTimestamp(): string {
  seq += 1;
  return new Date(Date.UTC(2025, 0, 1) + seq * 1000).toISOString();
}

/** Advance and return the monotonic sequence number (creation ordering). */
export function nextSeq(): number {
  seq += 1;
  return seq;
}

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

// ---------------------------------------------------------------------------
// Object store (global, content-addressed)
// ---------------------------------------------------------------------------

export const objects = new Map<string, GitObject>();

export function putObject(type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

/**
 * Store an object whose oid is already known (a pack reader computed it):
 * same as putObject but without hashing the data a second time.
 */
export function putObjectKnown(oid: string, type: ObjectType, data: Buffer): string {
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface Repo {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

export const repos = new Map<string, Repo>();
let nextDbId = 1000;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(
  name: string,
  opts: { description?: string; isPrivate?: boolean; defaultBranch?: string } = {},
): Repo {
  const createdAt = nextTimestamp();
  const repo: Repo = {
    dbId: nextDbId++,
    name,
    owner: VIEWER.login,
    description: opts.description ?? '',
    isPrivate: opts.isPrivate ?? false,
    defaultBranch: opts.defaultBranch ?? 'main',
    createdSeq: seq,
    createdAt,
    updatedAt: createdAt,
    refs: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextIssueNumber: 1,
    nextPullNumber: 1,
    nextCommentId: 1,
  };
  repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

export function listViewerRepos(): Repo[] {
  return [...repos.values()]
    .filter((repo) => repo.owner === VIEWER.login)
    .sort((a, b) => a.createdSeq - b.createdSeq);
}

// ---------------------------------------------------------------------------
// Global (GraphQL node) ids: opaque, deterministic, stable across reads.
// ---------------------------------------------------------------------------

export function repoNodeId(repo: Repo): string {
  return Buffer.from(`repo:${repo.dbId}`, 'utf8').toString('base64');
}

export function issueNodeId(repo: Repo, issue: Issue): string {
  return Buffer.from(`issue:${repo.dbId}:${issue.number}`, 'utf8').toString('base64');
}

export function pullNodeId(repo: Repo, pull: Pull): string {
  return Buffer.from(`pr:${repo.dbId}:${pull.number}`, 'utf8').toString('base64');
}

export function commentNodeId(repo: Repo, comment: IssueComment): string {
  return Buffer.from(`comment:${repo.dbId}:${comment.id}`, 'utf8').toString('base64');
}

export interface DecodedNodeId {
  kind: 'repo' | 'issue' | 'pr' | 'comment' | 'user';
  dbId: number;
  number: number;
}

export function decodeNodeId(id: string): DecodedNodeId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] === 'repo' && parts.length === 2) {
      return { kind: 'repo', dbId: Number(parts[1]), number: 0 };
    }
    if (parts[0] === 'issue' && parts.length === 3) {
      return { kind: 'issue', dbId: Number(parts[1]), number: Number(parts[2]) };
    }
    if (parts[0] === 'pr' && parts.length === 3) {
      return { kind: 'pr', dbId: Number(parts[1]), number: Number(parts[2]) };
    }
    if (parts[0] === 'comment' && parts.length === 3) {
      return { kind: 'comment', dbId: Number(parts[1]), number: Number(parts[2]) };
    }
    if (parts[0] === 'user' && parts.length === 2) {
      return { kind: 'user', dbId: Number(parts[1]), number: 0 };
    }
  } catch {
    return null;
  }
  return null;
}

export function findRepoByDbId(dbId: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.dbId === dbId) return repo;
  return undefined;
}

// ---------------------------------------------------------------------------
// Commit construction (contents PUT, squash merge)
// ---------------------------------------------------------------------------

/** Create a commit whose tree is `baseTree` (or empty) with `changes` applied. */
export function commitWithChanges(
  baseCommitOid: string | null,
  changes: Map<string, { mode: string; oid: string } | null>,
  message: string,
): string {
  const files = new Map<string, { mode: string; oid: string }>();
  if (baseCommitOid) {
    const base = getObject(baseCommitOid);
    if (base?.type === 'commit') {
      const treeOid = parseCommit(base.data).tree;
      for (const [path, entry] of flattenTree(treeOid, getObject)) files.set(path, entry);
    }
  }
  for (const [path, entry] of changes) {
    if (entry === null) files.delete(path);
    else files.set(path, entry);
  }
  const treeOid = buildTreesFromPaths(files, putObject);
  const parents = baseCommitOid ? [baseCommitOid] : [];
  const data = buildCommit({
    tree: treeOid,
    parents,
    message,
    author: COMMIT_AUTHOR,
    committer: COMMIT_AUTHOR,
    timestamp: COMMIT_TIMESTAMP,
  });
  return putObject('commit', data);
}

/** Resolve a ref name, branch name, or oid to a commit oid (or null). */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.refs.has(`refs/tags/${ref}`)) {
    const oid = repo.refs.get(`refs/tags/${ref}`)!;
    const obj = getObject(oid);
    if (obj?.type === 'tag') return parseTag(obj.data).object;
    return oid;
  }
  if (/^[0-9a-f]{40}$/.test(ref) && getObject(ref)) return ref;
  return null;
}

/** Flatten a commit's tree to path -> {mode, oid}. */
export function treeOfCommit(oid: string): Map<string, { mode: string; oid: string }> {
  const obj = getObject(oid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(parseCommit(obj.data).tree, getObject);
}

/** Three-way conflict: a path changed on both sides of the merge base. */
export function hasConflict(repo: Repo, headSha: string, baseSha: string): boolean {
  void repo;
  const base = mergeBase(headSha, baseSha, getObject);
  if (!base) return false;
  const baseFiles = treeOfCommit(base);
  const headFiles = treeOfCommit(headSha);
  const tipFiles = treeOfCommit(baseSha);
  const paths = new Set([...headFiles.keys(), ...tipFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid;
    const h = headFiles.get(path)?.oid;
    const t = tipFiles.get(path)?.oid;
    if (h !== b && t !== b && h !== t) return true;
  }
  return false;
}

/** The base branch's current tip for a pull request (live, not creation-time). */
export function currentBaseSha(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

/**
 * Squash-merge a pull request: one commit whose tree is the head tip's tree,
 * parented on the CURRENT base tip, landed on the base branch. Returns the
 * new commit oid, or null when the pull request is conflicted. The base tip
 * is read live: another pull request may have advanced the branch since this
 * one was created, and that is exactly when a conflict appears.
 */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  if (hasConflict(repo, pull.headSha, baseTip)) return null;
  const headFiles = treeOfCommit(pull.headSha);
  const baseFiles = treeOfCommit(baseTip);
  const changes = new Map<string, { mode: string; oid: string } | null>();
  for (const [path, entry] of headFiles) changes.set(path, entry);
  for (const path of baseFiles.keys()) if (!headFiles.has(path)) changes.set(path, null);
  const oid = commitWithChanges(
    baseTip,
    changes,
    `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nextTimestamp();
  pull.mergeCommitSha = oid;
  pull.updatedAt = nextTimestamp();
  repo.updatedAt = nextTimestamp();
  return oid;
}
