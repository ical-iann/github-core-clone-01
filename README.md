# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ical-iann/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ical-iann/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone git forge: one Node 22 process serving git smart HTTP, REST v3, GraphQL and MCP. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
npm start
```

# github-core-clone-01 — a standalone git forge

A single-process, dependency-free git forge for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01):
no UI, one Node 22 process serving git smart HTTP, REST v3, GraphQL and MCP
on one in-memory store, so an object created through any surface reads back
through the others.

## Run it

```sh
node --experimental-strip-types main.ts
```

No install step: the program uses the Node standard library only. In a trial
the platform runs `node /bot/main.ts` with `MAKEFUN_ENV_URL` and
`MAKEFUN_SHOP_TOKEN` set; `main.ts` (the starter lifecycle, unchanged) binds
an ephemeral port, registers it with the env, polls `/done`, and exits 0.
Locally, without `MAKEFUN_ENV_URL`, use `scripts/run-local.mjs` from the
parent directory (it starts the same `app.ts` on a fixed port):

```sh
MAKEFUN_SHOP_TOKEN=test-token PORT=18080 node --experimental-strip-types scripts/run-local.mjs
```

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Trial lifecycle (starter, unchanged): ephemeral port, register, poll `/done`. |
| `app.ts` | HTTP server: body assembly, routing, never dies on a bad request. |
| `lib/gitcore.ts` | Git object model: SHA-1 hashing, commit/tree/tag parsing, packfile read/write (plain + delta resolution), pkt-line and sideband framing, reachability. |
| `lib/store.ts` | In-memory data model: repos, refs, issues, pulls, labels, comments; deterministic timestamps; squash-merge with live conflict detection. |
| `lib/http.ts` | Request context and reply helpers; every REST reply is `application/json` with `X-GitHub-Request-Id` and `X-OAuth-Scopes`. |
| `lib/rest.ts` | GitHub REST API v3 (`/api/v3`). |
| `lib/gitproto.ts` | Git smart HTTP: protocol v2 and v0 upload-pack, v0 receive-pack. |
| `lib/graphql.ts` | GraphQL (`/api/graphql`): hand-rolled parser + executor, `__type` introspection, batched operation arrays. |
| `lib/mcp.ts` | MCP (`/mcp`): JSON-RPC 2.0 over Streamable HTTP, `server/discover` (2026-07-28) and legacy `initialize`. |

Total entry size is ~164 KB — far under the 16 MiB cap (8 MiB per file).

## Surfaces

### Git smart HTTP — `/{owner}/{repo}.git`

- `GET /info/refs?service=git-upload-pack` — protocol v2 when the client
  sends `Git-Protocol: version=2` (`version 2`, `ls-refs=unborn`,
  `fetch=shallow filter`, `object-format=sha1`), v0 otherwise
  (`side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main`);
  empty repos advertise the `capabilities^{}` pseudo-ref.
- `GET /info/refs?service=git-receive-pack` — v0 only
  (`report-status side-band-64k delete-refs ofs-delta`).
- `POST /git-upload-pack` — v2 `ls-refs` (HEAD symref, peeled annotated
  tags, server-side `ref-prefix` filtering) and `fetch` (thin-pack,
  `have`/`want`, `deepen`, shallow boundaries with `shallow`/`unshallow`
  lines), plus v0 fetch. Fetches never re-send objects the client holds;
  the held set stops at the client's shallow boundaries, so `deepen`
  delivers exactly one more generation.
- `POST /git-receive-pack` — pack parsing (plain and delta packs), per-ref
  fast-forward validation (`ng <ref> non-fast-forward`, mixed pushes apply
  only the ok refs), report-status inside sideband band 1. Packfiles are
  plain objects with a valid SHA-1 trailer; sideband packets respect the
  65520-byte pkt-line limit.

### REST v3 — `/api/v3`

- `GET /`, `GET /meta`, `GET /user`, `POST/GET /user/repos` (paginated,
  `Link` headers; duplicate name is 422 `Repository already exists`).
- `GET/PATCH/DELETE /repos/{owner}/{repo}` — the owner is always the token's
  user; any other owner is 404, never 403.
- Git data: `POST/GET /repos/{o}/{r}/git/refs`, `GET /branches[/{branch}]`,
  `GET /commits[?sha=<ref>]` (newest first, branch-scoped),
  `PUT/GET/DELETE /contents/{path}` (base64, `sha` concurrency, `branch`
  creation from the default tip; a PUT on an unborn repo creates the first
  commit).
- Issues: labels (must exist before use, else 422), `POST/GET/PATCH`
  issues, `state`/`sort=created`/`direction` filtering, comments.
- Pulls: `POST/GET` pulls, `GET /pulls/{n}/files` (three-way diff with
  line counts), `PUT /pulls/{n}/merge` (squash only; 405 on conflict,
  computed against the live base tip).
- Auth: every call needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
  (missing/wrong → 401 JSON). Unknown route → 404 JSON; malformed JSON
  body → 400 JSON.

### GraphQL — `/api/graphql`

`viewer`, `repository(owner, name)` (unknown → `null`, no errors),
`node(id:)` with inline fragments, `__type` introspection for `Issue`,
`PullRequest`, `Repository` and the `SearchType` enum, `issues`/`pullRequests`
connections with cursor pagination (`first`/`after`, `pageInfo`),
`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`
(`SQUASH`), `addComment`. Unknown fields answer HTTP 200 with an `errors`
array naming the field. A JSON array of operations in one body is answered
as an array, in order. `mergeable` is `MERGEABLE` / `CONFLICTING` /
`UNKNOWN`; a merged pull request reports state `MERGED` here (REST still
shows `closed` with `merged: true`).

### MCP — `/mcp`

JSON-RPC 2.0, `server/discover` advertising revisions
`2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26`, plus legacy
`initialize`. Eight tools: `create_repo`, `get_repo`, `create_issue`,
`list_issues`, `get_issue`, `create_pull_request`, `merge_pull_request`,
`list_pull_requests` — each with a non-empty description and an
`inputSchema` whose `required` list holds only the documented arguments.
`tools/list` is byte-identical across calls. Unknown tool → `-32601`;
missing required argument → `-32602`; non-JSON body → HTTP 400 with
`-32700`; no token → 401; notifications get an empty 202.

## Identity

The token's user is the viewer from the kit's published scenario:
`adaiversen` (id 1000). The server holds no credentials and embeds no API
keys; the token is read from `MAKEFUN_SHOP_TOKEN` at request time.

## Test results

Graded locally with the kit's own harness
(`node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 --token test-token --perf --json`),
four runs against fresh server processes:

| Run | Feature (/600) | MCP (/200) | Perf (/200) | Score (/1000) | Checks |
| --- | --- | --- | --- | --- | --- |
| 1 | 565 | 200 | 178 | 943 | 113/120 |
| 2 | 600 | 200 | 175 | 975 | 120/120 |
| 3 | 600 | 200 | 183 | 983 | 120/120 |
| 4 | 600 | 200 | 171 | 971 | 120/120 |

Run 1's 7 failures were fixed (empty-repo `ls-refs` shape, shallow
`deepen` held-set, 64 KiB pkt-line limit, commit-message newline, merge
conflict against the live base tip, GraphQL `repositoryId` as a global id);
runs 2–4 pass all 120 checks. Perf points vary run to run (171–183) with
host load; typical p50s are push ~600–750 ms, clone ~115 ms, read ~700 ms,
write ~115 ms. For reference, the bounty leader at access scored 953.

Raw grading JSON is kept beside the entry in `../tests/grade-run*.json`.

Additional verification:

- `tsc -p tsconfig.json` — clean (strict).
- Real `git` 2.43 CLI: clone → commit → push → clone round-trips against
  the forge (protocol v2 and v0), including an annotated tag push.
- A 29-assertion smoke script (`../scripts/smoke.mjs`) covers REST,
  GraphQL, MCP and error paths — all pass.
- Trial lifecycle checked against a fake env: ephemeral port, register,
  `/done` polling, exit 0.
- Kit integrity: all 63 files in `kit.json` verify by SHA-256 (the
  downloaded tarball's own SHA-256 differs from the transport header's,
  as with earlier bounties, but the contents are authentic).

## What is NOT done

This is a local build only. Nothing has been submitted anywhere:

- No GitHub repository has been created for this entry, and nothing has
  been pushed to GitHub.
- No make.fun entry, transcript bundle, or wallet signature exists.
- No private key was used or needed.

To submit, BOS still needs to: create a public GitHub repo on
`ical-iann` (created after the bounty opened, MIT licensed), commit this
entry, bundle the AI coding-agent session transcripts, and explicitly
confirm the submission. The bounty pays $500 in USDC on Solana from
make.fun's reward wallet (no escrow); the prize is paid only if the score
beats the house reference forge.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fjj5ptt9&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
