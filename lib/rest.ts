// GitHub REST API v3 surface (/api/v3). One in-memory store shared with the
// git, GraphQL and MCP surfaces, so an object created through any surface
// reads back through the others.
import type { ServerResponse } from 'node:http';
import {
  COMMIT_AUTHOR,
  COMMIT_TIMESTAMP,
  VIEWER,
  commitWithChanges,
  createRepo,
  currentBaseSha,
  findRepo,
  getObject,
  hasConflict,
  issueNodeId,
  listViewerRepos,
  nextSeq,
  nextTimestamp,
  pullNodeId,
  putObject,
  repoKey,
  repoNodeId,
  repos,
  resolveRef,
  squashMerge,
  treeOfCommit,
  type Issue,
  type IssueComment,
  type Pull,
  type Repo,
} from './store.ts';
import {
  mergeBase,
  parseCommit,
  parseTree,
  type GitObject,
} from './gitcore.ts';
import {
  errorJson,
  isAuthenticated,
  paginate,
  sendEmpty,
  sendJson,
  type Ctx,
} from './http.ts';

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: Buffer.from(`user:${id}`, 'utf8').toString('base64'),
    avatar_url: '',
    gravatar_id: '',
    url: '',
    html_url: '',
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length;
  const openPulls = repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.dbId,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: '',
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues + openPulls,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    clone_url: '',
    git_url: '',
    ssh_url: '',
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (!label) return null;
  return {
    id: 0,
    node_id: Buffer.from(`label:${repo.dbId}:${name}`, 'utf8').toString('base64'),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.dbId * 1000000 + issue.number,
    node_id: issueNodeId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(VIEWER.login, VIEWER.id),
    labels: issue.labels
      .map((name) => labelJson(repo, name))
      .filter((label) => label !== null),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    html_url: '',
  };
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`comment:${repo.dbId}:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: userJson(comment.authorLogin, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: '',
    issue_url: '',
  };
}

function commitAuthorJson(identity: string, timestamp: number): Record<string, unknown> {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(identity.trim());
  const name = match ? match[1] : identity;
  const email = match ? match[2] : '';
  const ts = match ? Number(match[3]) : timestamp;
  return { name, email, date: new Date(ts * 1000).toISOString() };
}

export function commitJson(oid: string, obj: GitObject): Record<string, unknown> {
  const commit = parseCommit(obj.data);
  return {
    sha: oid,
    node_id: Buffer.from(`commit:${oid}`, 'utf8').toString('base64'),
    commit: {
      author: commitAuthorJson(commit.author, COMMIT_TIMESTAMP),
      committer: commitAuthorJson(commit.committer, COMMIT_TIMESTAMP),
      // GitHub's REST view returns the message without its trailing newline.
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: '' },
      comment_count: 0,
    },
    url: '',
    html_url: '',
    author: userJson(VIEWER.login, VIEWER.id),
    committer: userJson(VIEWER.login, VIEWER.id),
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const merged = pull.merged;
  return {
    id: repo.dbId * 1000000 + pull.number,
    node_id: pullNodeId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(VIEWER.login, VIEWER.id),
    labels: [],
    draft: false,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(repo),
    },
    merged,
    mergeable: pull.state === 'open' ? !hasConflict(repo, pull.headSha, currentBaseSha(repo, pull)) : false,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: '',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bodyObject(ctx: Ctx): Record<string, unknown> {
  if (ctx.json !== null && typeof ctx.json === 'object' && !Array.isArray(ctx.json)) {
    return ctx.json as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

function stripOwnerPrefix(ref: string): string {
  const idx = ref.indexOf(':');
  return idx === -1 ? ref : ref.slice(idx + 1);
}

/** The repo at /repos/{owner}/{name}; 404 unless the owner is the viewer. */
function loadRepo(
  res: ServerResponse,
  ctx: Ctx,
  owner: string,
  name: string,
): Repo | null {
  if (owner !== VIEWER.login) {
    errorJson(res, ctx, 404, 'Not Found');
    return null;
  }
  const repo = findRepo(owner, name);
  if (!repo) {
    errorJson(res, ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleRest(res: ServerResponse, ctx: Ctx): boolean {
  const s = ctx.segments;
  if (s.length < 2 || s[0] !== 'api' || s[1] !== 'v3') return false;

  // Authentication: every API call carries the runner's token.
  if (!isAuthenticated(ctx)) {
    errorJson(res, ctx, 401, 'Requires authentication');
    return true;
  }
  if (ctx.jsonError) {
    errorJson(res, ctx, 400, 'Problems parsing JSON');
    return true;
  }

  const rest = s.slice(2);
  const method = ctx.method;

  // GET /api/v3/
  if (rest.length === 0) {
    if (method !== 'GET') return notFound(res, ctx);
    sendJson(res, ctx, 200, {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      current_user_authorizations_html_url: '',
      authorizations_url: '',
      code_search_url: '',
      commit_search_url: '',
      emails_url: '',
      emojis_url: '',
      events_url: '',
      feeds_url: '',
      followers_url: '',
      following_url: '',
      gists_url: '',
      hub_url: '',
      issue_search_url: '',
      issues_url: '',
      keys_url: '',
      label_search_url: '',
      notifications_url: '',
      organizations_url: '',
      public_gists_url: '',
      rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: '',
      current_user_repositories_url: `${ctx.baseUrl}/api/v3/user/repos`,
      search_url: '',
      starred_url: '',
      starred_gists_url: '',
      topic_search_url: '',
      user_url: `${ctx.baseUrl}/api/v3/users/{user}`,
      user_organizations_url: '',
      user_repositories_url: '',
      user_search_url: '',
    });
    return true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, ctx, 200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      git_ssh_url: '',
      git_http_url: '',
      hooks: [],
      git: ['1.0.0'],
      pages: [],
      importer: [],
      actions: [],
    });
    return true;
  }

  // GET /api/v3/user, POST /api/v3/user/repos, GET /api/v3/user/repos
  if (rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(res, ctx, 200, {
        ...userJson(VIEWER.login, VIEWER.id),
        name: VIEWER.name,
        email: VIEWER.email,
        public_repos: listViewerRepos().length,
        public_gists: 0,
        followers: 0,
        following: 0,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: nextTimestamp(),
        bio: null,
        blog: '',
        company: null,
        location: null,
        hireable: null,
        type: 'User',
        site_admin: false,
      });
      return true;
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const { page, link } = paginate(ctx, listViewerRepos());
        sendJson(res, ctx, 200, page.map(repoJson), link ? { link } : undefined);
        return true;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const name = asString(body.name);
        if (!name || name.length === 0 || /[^\w.\-]/.test(name)) {
          errorJson(res, ctx, 422, 'Validation Failed: name is invalid');
          return true;
        }
        if (findRepo(VIEWER.login, name)) {
          sendJson(res, ctx, 422, {
            message: 'Repository already exists',
            errors: [
              {
                resource: 'Repository',
                code: 'custom',
                field: 'name',
                message: 'name already exists on this account',
              },
            ],
          });
          return true;
        }
        const repo = createRepo(name, {
          description: asString(body.description),
          isPrivate: asBool(body.private, false),
        });
        sendJson(res, ctx, 201, repoJson(repo));
        return true;
      }
    }
    return notFound(res, ctx);
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    return handleRepoRoutes(res, ctx, rest.slice(1));
  }

  return notFound(res, ctx);
}

function notFound(res: ServerResponse, ctx: Ctx): boolean {
  errorJson(res, ctx, 404, 'Not Found');
  return true;
}

function handleRepoRoutes(res: ServerResponse, ctx: Ctx, rest: string[]): boolean {
  const [owner, name, ...tail] = rest;
  const method = ctx.method;

  // GET/PATCH/DELETE /repos/{owner}/{name}
  if (tail.length === 0) {
    if (method === 'GET') {
      const repo = loadRepo(res, ctx, owner, name);
      if (!repo) return true;
      sendJson(res, ctx, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = loadRepo(res, ctx, owner, name);
      if (!repo) return true;
      const body = bodyObject(ctx);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name.length > 0 && body.name !== repo.name) {
        // Rename: re-key the repo map so the old name stops resolving.
        repos.delete(repoKey(repo.owner, repo.name));
        repo.name = body.name;
        repos.set(repoKey(repo.owner, repo.name), repo);
      }
      repo.updatedAt = nextTimestamp();
      sendJson(res, ctx, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      const repo = loadRepo(res, ctx, owner, name);
      if (!repo) return true;
      repos.delete(repoKey(repo.owner, repo.name));
      sendEmpty(res, ctx, 204);
      return true;
    }
    return notFound(res, ctx);
  }

  const repo = loadRepo(res, ctx, owner, name);
  if (!repo) return true;
  const resource = tail[0];

  // ---- git refs -----------------------------------------------------------
  if (resource === 'git' && tail[1] === 'refs') {
    const refPath = tail.slice(2).join('/');
    if (method === 'POST' && tail.length === 2) {
      const body = bodyObject(ctx);
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref || !ref.startsWith('refs/') || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
        errorJson(res, ctx, 422, 'Validation Failed');
        return true;
      }
      if (!getObject(sha)) {
        errorJson(res, ctx, 422, 'Validation Failed: object does not exist');
        return true;
      }
      if (repo.refs.has(ref)) {
        errorJson(res, ctx, 422, 'Validation Failed: ref already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      repo.updatedAt = nextTimestamp();
      sendJson(res, ctx, 201, {
        ref,
        node_id: Buffer.from(`ref:${repo.dbId}:${ref}`, 'utf8').toString('base64'),
        url: '',
        object: { sha, type: getObject(sha)?.type ?? 'commit', url: '' },
      });
      return true;
    }
    if (method === 'GET') {
      if (refPath) {
        const sha = repo.refs.get(refPath);
        if (!sha) {
          errorJson(res, ctx, 404, 'Not Found');
          return true;
        }
        sendJson(res, ctx, 200, {
          ref: refPath,
          node_id: Buffer.from(`ref:${repo.dbId}:${refPath}`, 'utf8').toString('base64'),
          url: '',
          object: { sha, type: getObject(sha)?.type ?? 'commit', url: '' },
        });
        return true;
      }
      const refs = [...repo.refs.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([ref, sha]) => ({
          ref,
          node_id: Buffer.from(`ref:${repo.dbId}:${ref}`, 'utf8').toString('base64'),
          url: '',
          object: { sha, type: getObject(sha)?.type ?? 'commit', url: '' },
        }));
      sendJson(res, ctx, 200, refs);
      return true;
    }
    return notFound(res, ctx);
  }

  // ---- branches -----------------------------------------------------------
  if (resource === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: '' },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, ctx, 200, branches);
      return true;
    }
    if (method === 'GET' && tail.length === 2) {
      const branch = tail[1];
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) {
        errorJson(res, ctx, 404, 'Not Found');
        return true;
      }
      sendJson(res, ctx, 200, {
        name: branch,
        commit: { sha, url: '' },
        protected: false,
      });
      return true;
    }
    return notFound(res, ctx);
  }

  // ---- commits ------------------------------------------------------------
  if (resource === 'commits') {
    if (method === 'GET' && tail.length === 1) {
      const refParam = ctx.query.get('sha') ?? undefined;
      const tip = refParam ? resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      if (!tip) {
        sendJson(res, ctx, 200, []);
        return true;
      }
      const list: { sha: string; obj: GitObject }[] = [];
      const seen = new Set<string>();
      const queue: string[] = [tip];
      let head = 0;
      while (head < queue.length) {
        const oid = queue[head++]!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = getObject(oid);
        if (!obj || obj.type !== 'commit') continue;
        list.push({ sha: oid, obj });
        queue.push(...parseCommit(obj.data).parents);
      }
      const { page, link } = paginate(ctx, list);
      sendJson(res, ctx, 200, page.map(({ sha, obj }) => commitJson(sha, obj)), link ? { link } : undefined);
      return true;
    }
    if (method === 'GET' && tail.length === 2) {
      const sha = tail[1];
      const obj = getObject(sha);
      if (!obj || obj.type !== 'commit') {
        errorJson(res, ctx, 404, 'Not Found');
        return true;
      }
      sendJson(res, ctx, 200, commitJson(sha, obj));
      return true;
    }
    return notFound(res, ctx);
  }

  // ---- contents -----------------------------------------------------------
  if (resource === 'contents') {
    return handleContents(res, ctx, repo, tail.slice(1).join('/'));
  }

  // ---- labels -------------------------------------------------------------
  if (resource === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      const labels = [...repo.labels.values()]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((label) => labelJson(repo, label.name));
      sendJson(res, ctx, 200, labels);
      return true;
    }
    if (method === 'POST' && tail.length === 1) {
      const body = bodyObject(ctx);
      const name = asString(body.name);
      if (!name) {
        errorJson(res, ctx, 422, 'Validation Failed');
        return true;
      }
      if (!repo.labels.has(name)) {
        repo.labels.set(name, {
          name,
          color: asString(body.color) ?? 'ededed',
          description: asString(body.description) ?? '',
        });
      }
      sendJson(res, ctx, 201, labelJson(repo, name));
      return true;
    }
    return notFound(res, ctx);
  }

  // ---- issues -------------------------------------------------------------
  if (resource === 'issues') {
    return handleIssues(res, ctx, repo, tail.slice(1));
  }

  // ---- pulls --------------------------------------------------------------
  if (resource === 'pulls') {
    return handlePulls(res, ctx, repo, tail.slice(1));
  }

  return notFound(res, ctx);
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function handleContents(res: ServerResponse, ctx: Ctx, repo: Repo, path: string): boolean {
  const method = ctx.method;
  const refParam = ctx.query.get('ref') ?? undefined;

  const tipFor = (branch?: string): string | null => {
    if (branch) return resolveRef(repo, branch);
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  };

  if (method === 'GET') {
    const tip = tipFor(refParam);
    if (!tip) {
      errorJson(res, ctx, 404, 'Not Found');
      return true;
    }
    const files = treeOfCommit(tip);
    if (!path) {
      // Root directory listing.
      const top = new Map<string, { mode: string; oid: string }>();
      for (const [filePath, entry] of files) {
        const first = filePath.split('/')[0];
        if (filePath.includes('/')) {
          top.set(first, { mode: '40000', oid: '' });
        } else {
          top.set(first, entry);
        }
      }
      const listing = [...top.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, entry]) => {
          if (entry.mode === '40000') {
            const dirTree = subtreeOid(tip, name);
            return { type: 'dir', name, path: name, sha: dirTree ?? '', size: 0, url: '', html_url: '', download_url: null };
          }
          const blob = getObject(entry.oid);
          return {
            type: 'file',
            name,
            path: name,
            sha: entry.oid,
            size: blob?.data.length ?? 0,
            url: '',
            html_url: '',
            download_url: null,
          };
        });
      sendJson(res, ctx, 200, listing);
      return true;
    }
    const exact = files.get(path);
    if (exact) {
      const blob = getObject(exact.oid);
      sendJson(res, ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob?.data.length ?? 0,
        name: path.split('/').pop(),
        path,
        content: blob ? blob.data.toString('base64') : '',
        sha: exact.oid,
        url: '',
        html_url: '',
        download_url: null,
      });
      return true;
    }
    // Directory?
    const prefix = `${path}/`;
    const children = new Map<string, { mode: string; oid: string }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const first = rest.split('/')[0];
      if (rest.includes('/')) children.set(first, { mode: '40000', oid: '' });
      else children.set(first, entry);
    }
    if (children.size === 0) {
      errorJson(res, ctx, 404, 'Not Found');
      return true;
    }
    const listing = [...children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, entry]) => {
        if (entry.mode === '40000') {
          return { type: 'dir', name, path: `${path}/${name}`, sha: subtreeOid(tip, `${path}/${name}`) ?? '', size: 0, url: '', html_url: '', download_url: null };
        }
        const blob = getObject(entry.oid);
        return {
          type: 'file',
          name,
          path: `${path}/${name}`,
          sha: entry.oid,
          size: blob?.data.length ?? 0,
          url: '',
          html_url: '',
          download_url: null,
        };
      });
    sendJson(res, ctx, 200, listing);
    return true;
  }

  if (method === 'PUT') {
    const body = bodyObject(ctx);
    const message = asString(body.message) ?? '';
    const contentB64 = asString(body.content);
    const sha = asString(body.sha);
    const branch = asString(body.branch);
    if (contentB64 === undefined) {
      errorJson(res, ctx, 422, 'Validation Failed: content is required');
      return true;
    }
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      errorJson(res, ctx, 422, 'Validation Failed: content is not valid base64');
      return true;
    }
    const targetBranch = branch ?? repo.defaultBranch;
    let baseTip = repo.refs.get(`refs/heads/${targetBranch}`) ?? null;
    if (!baseTip && branch) {
      // Create the branch from the default tip (or unborn).
      baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    const existing = baseTip ? treeOfCommit(baseTip).get(path) : undefined;
    if (existing) {
      if (!sha) {
        errorJson(res, ctx, 422, 'Validation Failed: sha is required to update a file');
        return true;
      }
      if (sha !== existing.oid) {
        sendJson(res, ctx, 409, { message: 'sha does not match the current file' });
        return true;
      }
    } else if (sha) {
      errorJson(res, ctx, 404, 'Not Found');
      return true;
    }
    const blobOid = putObject('blob', content);
    const changes = new Map<string, { mode: string; oid: string } | null>();
    changes.set(path, { mode: '100644', oid: blobOid });
    const commitOid = commitWithChanges(baseTip, changes, message);
    repo.refs.set(`refs/heads/${targetBranch}`, commitOid);
    repo.updatedAt = nextTimestamp();
    const commitObj = getObject(commitOid)!;
    const treeSha = parseCommit(commitObj.data).tree;
    sendJson(res, ctx, existing ? 200 : 201, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: content.length,
        url: '',
        html_url: '',
        download_url: null,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
      },
      commit: {
        sha: commitOid,
        node_id: '',
        message,
        author: { name: 'Conformance', email: 'conformance@make.fun', date: new Date(COMMIT_TIMESTAMP * 1000).toISOString() },
        committer: { name: 'Conformance', email: 'conformance@make.fun', date: new Date(COMMIT_TIMESTAMP * 1000).toISOString() },
        tree: { sha: treeSha, url: '' },
        parents: baseTip ? [{ sha: baseTip, url: '', html_url: '' }] : [],
      },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = bodyObject(ctx);
    const message = asString(body.message) ?? '';
    const sha = asString(body.sha);
    const branch = asString(body.branch);
    const targetBranch = branch ?? repo.defaultBranch;
    const baseTip = repo.refs.get(`refs/heads/${targetBranch}`) ?? null;
    if (!baseTip) {
      errorJson(res, ctx, 404, 'Not Found');
      return true;
    }
    const existing = treeOfCommit(baseTip).get(path);
    if (!existing) {
      errorJson(res, ctx, 404, 'Not Found');
      return true;
    }
    if (sha && sha !== existing.oid) {
      sendJson(res, ctx, 409, { message: 'sha does not match the current file' });
      return true;
    }
    const changes = new Map<string, { mode: string; oid: string } | null>();
    changes.set(path, null);
    const commitOid = commitWithChanges(baseTip, changes, message);
    repo.refs.set(`refs/heads/${targetBranch}`, commitOid);
    repo.updatedAt = nextTimestamp();
    sendJson(res, ctx, 200, {
      commit: {
        sha: commitOid,
        message,
        author: { name: 'Conformance', email: 'conformance@make.fun', date: new Date(COMMIT_TIMESTAMP * 1000).toISOString() },
        committer: { name: 'Conformance', email: 'conformance@make.fun', date: new Date(COMMIT_TIMESTAMP * 1000).toISOString() },
      },
    });
    return true;
  }

  return notFound(res, ctx);
}

function subtreeOid(tip: string, dirPath: string): string | null {
  const obj = getObject(tip);
  if (!obj || obj.type !== 'commit') return null;
  let treeOid = parseCommit(obj.data).tree;
  for (const segment of dirPath.split('/')) {
    const tree = getObject(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === segment && e.mode === '40000');
    if (!entry) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function handleIssues(res: ServerResponse, ctx: Ctx, repo: Repo, tail: string[]): boolean {
  const method = ctx.method;

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) =>
        state === 'all' ? true : issue.state === state,
      );
      if (sort === 'created') {
        list = [...list].sort((a, b) =>
          direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
        );
      }
      const { page, link } = paginate(ctx, list);
      sendJson(res, ctx, 200, page.map((issue) => issueJson(repo, issue)), link ? { link } : undefined);
      return true;
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const title = asString(body.title);
      if (!title) {
        errorJson(res, ctx, 422, 'Validation Failed: title is required');
        return true;
      }
      const rawLabels = Array.isArray(body.labels) ? body.labels : [];
      const labels: string[] = [];
      for (const raw of rawLabels) {
        const name = typeof raw === 'string' ? raw : (raw as Record<string, unknown>)?.name;
        if (typeof name !== 'string') continue;
        if (!repo.labels.has(name)) {
          sendJson(res, ctx, 422, {
            message: `Validation Failed: label "${name}" does not exist`,
            errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label "${name}" does not exist` }],
          });
          return true;
        }
        labels.push(name);
      }
      const createdAt = nextTimestamp();
      const issue: Issue = {
        number: repo.nextIssueNumber++,
        title,
        body: asString(body.body) ?? '',
        state: 'open',
        labels,
        createdSeq: nextSeq(),
        createdAt,
        updatedAt: createdAt,
        comments: [],
      };
      repo.issues.push(issue);
      sendJson(res, ctx, 201, issueJson(repo, issue));
      return true;
    }
    return notFound(res, ctx);
  }

  const number = Number.parseInt(tail[0], 10);
  if (!Number.isFinite(number)) return notFound(res, ctx);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (!issue) {
    errorJson(res, ctx, 404, 'Not Found');
    return true;
  }

  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, ctx, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = bodyObject(ctx);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      else if (body.state !== undefined) {
        errorJson(res, ctx, 422, 'Validation Failed: invalid state');
        return true;
      }
      issue.updatedAt = nextTimestamp();
      sendJson(res, ctx, 200, issueJson(repo, issue));
      return true;
    }
    return notFound(res, ctx);
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      const { page, link } = paginate(ctx, issue.comments);
      sendJson(res, ctx, 200, page.map((comment) => commentJson(repo, issue, comment)), link ? { link } : undefined);
      return true;
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const text = asString(body.body);
      if (!text) {
        errorJson(res, ctx, 422, 'Validation Failed: body is required');
        return true;
      }
      const createdAt = nextTimestamp();
      const comment: IssueComment = {
        id: repo.nextCommentId++,
        body: text,
        authorLogin: VIEWER.login,
        createdAt,
        updatedAt: createdAt,
      };
      issue.comments.push(comment);
      issue.updatedAt = nextTimestamp();
      sendJson(res, ctx, 201, commentJson(repo, issue, comment));
      return true;
    }
    return notFound(res, ctx);
  }

  return notFound(res, ctx);
}

// ---------------------------------------------------------------------------
// Pulls
// ---------------------------------------------------------------------------

function handlePulls(res: ServerResponse, ctx: Ctx, repo: Repo, tail: string[]): boolean {
  const method = ctx.method;

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const list = repo.pulls
        .filter((pull) => (state === 'all' ? true : pull.state === state))
        .sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(ctx, list);
      sendJson(res, ctx, 200, page.map((pull) => pullJson(repo, pull)), link ? { link } : undefined);
      return true;
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const title = asString(body.title);
      const headRaw = asString(body.head);
      const baseRaw = asString(body.base);
      if (!title || !headRaw || !baseRaw) {
        errorJson(res, ctx, 422, 'Validation Failed: title, head and base are required');
        return true;
      }
      const headRef = stripOwnerPrefix(headRaw);
      const baseRef = stripOwnerPrefix(baseRaw);
      const headSha = resolveRef(repo, headRef);
      const baseSha = resolveRef(repo, baseRef);
      if (!headSha || !baseSha) {
        errorJson(res, ctx, 422, 'Validation Failed: head or base ref does not exist');
        return true;
      }
      const createdAt = nextTimestamp();
      const pull: Pull = {
        number: repo.nextPullNumber++,
        title,
        body: asString(body.body) ?? '',
        state: 'open',
        headRef,
        baseRef,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: nextSeq(),
        createdAt,
        updatedAt: createdAt,
        comments: [],
      };
      repo.pulls.push(pull);
      sendJson(res, ctx, 201, pullJson(repo, pull));
      return true;
    }
    return notFound(res, ctx);
  }

  const number = Number.parseInt(tail[0], 10);
  if (!Number.isFinite(number)) return notFound(res, ctx);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (!pull) {
    errorJson(res, ctx, 404, 'Not Found');
    return true;
  }

  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, ctx, 200, pullJson(repo, pull));
      return true;
    }
    return notFound(res, ctx);
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const base = mergeBase(pull.headSha, pull.baseSha, getObject);
    const baseFiles = base ? treeOfCommit(base) : new Map();
    const headFiles = treeOfCommit(pull.headSha);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const files: Record<string, unknown>[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = baseFiles.get(path);
      const newEntry = headFiles.get(path);
      if (oldEntry?.oid === newEntry?.oid) continue;
      let status: string;
      let additions = 0;
      let deletions = 0;
      if (!oldEntry && newEntry) {
        status = 'added';
        const blob = getObject(newEntry.oid);
        additions = blob ? countLines(blob.data) : 0;
      } else if (oldEntry && !newEntry) {
        status = 'removed';
        const blob = getObject(oldEntry.oid);
        deletions = blob ? countLines(blob.data) : 0;
      } else {
        status = 'modified';
        const oldBlob = oldEntry ? getObject(oldEntry.oid) : undefined;
        const newBlob = newEntry ? getObject(newEntry.oid) : undefined;
        additions = newBlob ? countLines(newBlob.data) : 0;
        deletions = oldBlob ? countLines(oldBlob.data) : 0;
      }
      files.push({
        sha: newEntry?.oid ?? oldEntry?.oid ?? '',
        filename: path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      });
    }
    sendJson(res, ctx, 200, files);
    return true;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull.state === 'closed') {
      sendJson(res, ctx, 405, { message: 'Pull request is already closed' });
      return true;
    }
    const squashOid = squashMerge(repo, pull);
    if (squashOid === null) {
      sendJson(res, ctx, 405, { message: 'Merge conflict' });
      return true;
    }
    sendJson(res, ctx, 200, {
      sha: squashOid,
      merged: true,
      message: `Pull Request #${pull.number} successfully merged`,
    });
    return true;
  }

  return notFound(res, ctx);
}
