// HTTP server: dispatches to the four surfaces of the forge — git smart HTTP,
// REST v3, GraphQL, and MCP — plus /healthz. A handler error never kills the
// process: the suite probes error paths (malformed bodies, unknown routes)
// and then keeps using the server.
import { createServer, type Server } from 'node:http';
import { buildCtx, sendJson, type Ctx } from './lib/http.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleGit } from './lib/gitproto.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let destroyed = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        destroyed = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (destroyed) return;
      const body = Buffer.concat(chunks);
      let ctx: Ctx;
      try {
        ctx = buildCtx(req, body);
      } catch {
        try {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Bad Request' }));
        } catch {
          // The socket is already gone; nothing more to do.
        }
        return;
      }
      try {
        if (ctx.segments.length === 1 && ctx.segments[0] === 'healthz') {
          sendJson(res, ctx, 200, { ok: true });
          return;
        }
        const handled =
          handleRest(res, ctx) ||
          handleGraphQL(res, ctx) ||
          handleMcp(res, ctx) ||
          handleGit(res, ctx);
        if (!handled) {
          sendJson(res, ctx, 404, { message: 'Not Found' });
        }
      } catch (err) {
        process.stderr.write(
          `[app] handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
        try {
          sendJson(res, ctx, 500, { message: 'Internal Server Error' });
        } catch {
          try {
            res.writeHead(500);
            res.end();
          } catch {
            // Socket gone.
          }
        }
      }
    });
    req.on('error', () => {
      try {
        res.writeHead(400);
        res.end();
      } catch {
        // Socket gone.
      }
    });
  });
}
