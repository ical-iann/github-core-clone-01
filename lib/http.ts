// Shared request context and reply helpers for every surface (REST, GraphQL,
// MCP, git smart HTTP). Every REST reply is application/json with a
// non-empty X-GitHub-Request-Id header, including errors.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { nextRequestId } from './store.ts';

export interface Ctx {
  method: string;
  url: URL;
  /** Decoded path segments, e.g. ['api','v3','repos','adaiversen','demo']. */
  segments: string[];
  /** The raw (still encoded) pathname, for routes where a segment holds '/'. */
  rawPathname: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  /** Parsed JSON body (undefined when the body is empty). */
  json: unknown;
  /** True when a non-empty body failed to parse as JSON. */
  jsonError: boolean;
  reqId: string;
  /** http://<host> as the client addressed us, for absolute Link URLs. */
  baseUrl: string;
}

export function buildCtx(req: IncomingMessage, body: Buffer): Ctx {
  const host = req.headers.host ?? '127.0.0.1';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  let json: unknown;
  let jsonError = false;
  if (body.length > 0) {
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      jsonError = true;
    }
  }
  return {
    method: req.method ?? 'GET',
    url,
    segments,
    rawPathname: url.pathname,
    query: url.searchParams,
    headers: req.headers,
    body,
    json,
    jsonError,
    reqId: nextRequestId(),
    baseUrl: `http://${host}`,
  };
}

export function jsonHeaders(ctx: Ctx, extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-github-request-id': ctx.reqId,
    'x-oauth-scopes': 'repo, read:org',
    ...extra,
  };
}

export function sendJson(
  res: ServerResponse,
  ctx: Ctx,
  status: number,
  value: unknown,
  extra?: Record<string, string>,
): void {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { ...jsonHeaders(ctx, extra), 'content-length': payload.length });
  res.end(payload);
}

export function sendEmpty(res: ServerResponse, ctx: Ctx, status: number): void {
  res.writeHead(status, jsonHeaders(ctx));
  res.end();
}

export function sendText(
  res: ServerResponse,
  ctx: Ctx,
  status: number,
  value: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  const payload = Buffer.from(value, 'utf8');
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': ctx.reqId,
    'content-length': payload.length,
  });
  res.end(payload);
}

export function sendBytes(
  res: ServerResponse,
  ctx: Ctx,
  status: number,
  value: Buffer,
  contentType: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': ctx.reqId,
    'content-length': value.length,
  });
  res.end(value);
}

export function errorJson(
  res: ServerResponse,
  ctx: Ctx,
  status: number,
  message: string,
): void {
  sendJson(res, ctx, status, { message });
}

/** Bearer token from the Authorization header, or null. */
export function bearerToken(ctx: Ctx): string | null {
  const header = ctx.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1] : null;
}

/** The token the runner configured, or null when running locally unconfigured. */
export function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token && token.length > 0 ? token : null;
}

/** True when this request is authenticated for the API surfaces. */
export function isAuthenticated(ctx: Ctx): boolean {
  const expected = expectedToken();
  const token = bearerToken(ctx);
  if (!token) return false;
  if (expected === null) return true;
  return token === expected;
}

/** Parse a positive integer query param with a default. */
export function queryInt(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Build a GitHub-style Link header for paginated lists. */
export function linkHeader(ctx: Ctx, page: number, perPage: number, total: number): string | undefined {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return undefined;
  const urlFor = (p: number): string => {
    const url = new URL(ctx.url.toString());
    url.searchParams.set('page', String(p));
    url.searchParams.set('per_page', String(perPage));
    return url.toString();
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

/** Slice a list for the requested page and return [pageItems, linkHeader]. */
export function paginate<T>(
  ctx: Ctx,
  items: T[],
): { page: T[]; link: string | undefined } {
  const perPage = Math.min(100, queryInt(ctx, 'per_page', 30));
  const page = queryInt(ctx, 'page', 1);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), link: linkHeader(ctx, page, perPage, items.length) };
}
