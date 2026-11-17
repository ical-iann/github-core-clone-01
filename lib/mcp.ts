// MCP over /mcp: JSON-RPC 2.0 over Streamable HTTP (modern era 2026-07-28
// via server/discover; legacy initialize is also answered). Tools act on the
// same store as REST/GraphQL/git, so anything created here reads back there.
import type { ServerResponse } from 'node:http';
import {
  VIEWER,
  createRepo,
  findRepo,
  nextSeq,
  nextTimestamp,
  resolveRef,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { errorJson, isAuthenticated, sendEmpty, sendJson, type Ctx } from './http.ts';

const SERVER_NAME = 'makefun-forge-mcp';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name (owner/repo).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name (owner/repo).' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name (owner/repo).' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name (owner/repo).' },
        issue_number: { type: 'integer', description: 'Issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name (owner/repo).' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name (owner/repo).' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name (owner/repo).' },
        state: { type: 'string', description: 'Pull request state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

let sessionCounter = 0;

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/** Resolve owner/repo from the several shapes the suite may pass. */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : undefined;
  let repo = typeof args.repo === 'string' ? args.repo : undefined;
  const fullName = typeof args.full_name === 'string' ? args.full_name : undefined;
  if ((!owner || !repo) && fullName) {
    const [o, r] = fullName.split('/');
    owner = owner ?? o;
    repo = repo ?? r;
  }
  if (typeof args.name === 'string' && !repo) repo = args.name;
  return { owner: owner ?? '', repo: repo ?? '' };
}

function loadRepoForTool(args: Record<string, unknown>): Repo | null {
  const { owner, repo } = resolveRepoArgs(args);
  if (!owner || !repo) return null;
  if (owner !== VIEWER.login) return null;
  return findRepo(owner, repo) ?? null;
}

function toolTextResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!tool) {
    throw { code: -32601, message: `Unknown tool: ${name}` } as RpcError;
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      // full_name may stand in for owner/repo.
      if ((required === 'owner' || required === 'repo') && typeof args.full_name === 'string') continue;
      if (required === 'repo' && typeof args.name === 'string') continue;
      throw { code: -32602, message: `Missing required argument: ${required}` } as RpcError;
    }
  }

  switch (tool.name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (findRepo(VIEWER.login, repoName)) {
        return toolErrorResult('Repository already exists');
      }
      const repo = createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : undefined,
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      return toolTextResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = loadRepoForTool(args);
      if (!repo) return toolErrorResult('Not Found');
      return toolTextResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = loadRepoForTool(args);
      if (!repo) return toolErrorResult('Not Found');
      const title = args.title as string;
      const createdAt = nextTimestamp();
      const issue: Issue = {
        number: repo.nextIssueNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdSeq: nextSeq(),
        createdAt,
        updatedAt: createdAt,
        comments: [],
      };
      repo.issues.push(issue);
      return toolTextResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = loadRepoForTool(args);
      if (!repo) return toolErrorResult('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues
        .filter((issue) => (state === 'all' ? true : issue.state === state))
        .sort((a, b) => b.createdSeq - a.createdSeq);
      return toolTextResult(list.map((issue) => issueJson(repo, issue)));
    }
    case 'get_issue': {
      const repo = loadRepoForTool(args);
      if (!repo) return toolErrorResult('Not Found');
      const issue = repo.issues.find((entry) => entry.number === Number(args.issue_number));
      if (!issue) return toolErrorResult('Not Found');
      return toolTextResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = loadRepoForTool(args);
      if (!repo) return toolErrorResult('Not Found');
      const headRef = args.head as string;
      const baseRef = args.base as string;
      const headSha = resolveRef(repo, headRef);
      const baseSha = resolveRef(repo, baseRef);
      if (!headSha || !baseSha) return toolErrorResult('Head or base ref does not exist');
      const createdAt = nextTimestamp();
      const pull: Pull = {
        number: repo.nextPullNumber++,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolTextResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = loadRepoForTool(args);
      if (!repo) return toolErrorResult('Not Found');
      const pull = repo.pulls.find((entry) => entry.number === Number(args.pull_number));
      if (!pull) return toolErrorResult('Not Found');
      if (pull.state === 'closed') return toolErrorResult('Pull request is already closed');
      const merged = squashMerge(repo, pull);
      if (merged === null) return toolErrorResult('Merge conflict');
      return toolTextResult({ ...pullJson(repo, pull), sha: merged });
    }
    case 'list_pull_requests': {
      const repo = loadRepoForTool(args);
      if (!repo) return toolErrorResult('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.pulls
        .filter((pull) => (state === 'all' ? true : pull.state === state))
        .sort((a, b) => b.createdSeq - a.createdSeq);
      return toolTextResult(list.map((pull) => pullJson(repo, pull)));
    }
    default:
      throw { code: -32601, message: `Unknown tool: ${name}` } as RpcError;
  }
}

export function handleMcp(res: ServerResponse, ctx: Ctx): boolean {
  if (ctx.segments.length !== 1 || ctx.segments[0] !== 'mcp') return false;
  if (ctx.method !== 'POST') {
    errorJson(res, ctx, 405, 'Method Not Allowed');
    return true;
  }
  if (!isAuthenticated(ctx)) {
    errorJson(res, ctx, 401, 'Requires authentication');
    return true;
  }
  if (ctx.jsonError || ctx.json === null || typeof ctx.json !== 'object' || Array.isArray(ctx.json)) {
    sendJson(res, ctx, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return true;
  }
  const body = ctx.json as Record<string, unknown>;
  const method = body.method as string | undefined;
  const id = body.id as unknown;
  const params = (body.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are acknowledged with an empty 202.
  if (id === undefined || id === null) {
    if (typeof method === 'string' && method.startsWith('notifications/')) {
      sendEmpty(res, ctx, 202);
      return true;
    }
    // A request without an id is a notification by JSON-RPC rules.
    sendEmpty(res, ctx, 202);
    return true;
  }

  // Session handling: echo the client's session id, or mint one.
  const incomingSession = ctx.headers['mcp-session-id'];
  const sessionId = typeof incomingSession === 'string' ? incomingSession : `sess-${++sessionCounter}`;
  const extraHeaders: Record<string, string> = { 'mcp-session-id': sessionId };

  if (method === 'server/discover') {
    sendJson(
      res,
      ctx,
      200,
      rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        protocolVersion: '2026-07-28',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
      extraHeaders,
    );
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    sendJson(
      res,
      ctx,
      200,
      rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      extraHeaders,
    );
    return true;
  }
  if (method === 'ping') {
    sendJson(res, ctx, 200, rpcResult(id, {}), extraHeaders);
    return true;
  }
  if (method === 'tools/list') {
    sendJson(res, ctx, 200, rpcResult(id, { tools: TOOLS }), extraHeaders);
    return true;
  }
  if (method === 'tools/call') {
    const name = params.name as string | undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!name) {
      sendJson(res, ctx, 200, rpcError(id, { code: -32602, message: 'Missing tool name' }), extraHeaders);
      return true;
    }
    try {
      const result = callTool(name, args);
      sendJson(res, ctx, 200, rpcResult(id, result), extraHeaders);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in (err as object)) {
        sendJson(res, ctx, 200, rpcError(id, err as RpcError), extraHeaders);
      } else {
        sendJson(
          res,
          ctx,
          200,
          rpcError(id, { code: -32603, message: err instanceof Error ? err.message : 'Internal error' }),
          extraHeaders,
        );
      }
    }
    return true;
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    sendEmpty(res, ctx, 202);
    return true;
  }
  sendJson(res, ctx, 200, rpcError(id, { code: -32601, message: `Method not found: ${method ?? ''}` }), extraHeaders);
  return true;
}
