# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/thoriqmaulana23-bit/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/thoriqmaulana23-bit/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, standard library only: git smart HTTP (upload-pack protocol v2 with a v0 fallback, receive-pack v0, with its own packfile generation and parsing including OFS/REF delta resolution), the REST v3 API, GraphQL v4, and an MCP endpoint over Streamable HTTP — all over one in-memory store, deterministic across replays (no wall clock, no unseeded randomness, sequential ids).

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, serves until the env says the trial is done, then exits 0. There is nothing to install: it imports `node:http`, `node:crypto`, `node:zlib` and its own modules only, and the trial has no package manager and no internet.

## Layout

- `main.ts`: the entry ↔ env lifecycle (bind, register, poll `/done`, exit 0). Kept as the kit ships it.
- `app.ts`: the HTTP server and router — health probe, API root, REST v3, GraphQL v4, MCP, git smart HTTP.
- `lib/store.ts`: the in-memory store — git objects (blob/tree/commit/tag), refs, repos, issues, pulls — plus deterministic ids and timestamps.
- `lib/git.ts`: pkt-line framing and packfiles: generation (full objects) and parsing (OFS/REF deltas).
- `lib/githttp.ts`: the smart-HTTP handlers — v2/v0 advertisements, ls-refs, fetch (including shallow/deepen), receive-pack with per-ref fast-forward checks and report-status.
- `lib/rest.ts`: GitHub REST v3 — repositories, branches, commits, contents, labels, issues, comments, pull requests and squash merges.
- `lib/graphql.ts`: GraphQL v4 — a small parser and executor for the documents `gh` and `github-mcp-server` send, with introspection, opaque global ids, cursor pagination and batched operations.
- `lib/mcp.ts`: MCP over Streamable HTTP — `server/discover` (revision 2026-07-28), the legacy `initialize` handshake, `tools/list` and `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and `merge_pull_request`.

## Notes

- Auth: every API surface takes `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is 401, and a repository under another owner is 404, never 403.
- Determinism: timestamps come from `MAKEFUN_TRIAL_NOW` when the trial sets it, otherwise a fixed epoch; ids are sequential; ordering is deterministic everywhere, so two runs on the same instance leave the same state export byte for byte.
- The repository is mounted read-only at `/bot` in the trial; the server keeps everything in memory and writes nothing at runtime.

---

<sub>Entered on [make.fun](https://make.fun/?ref=xnb5kged&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
