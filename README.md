<!-- Modified by surplus96 for atlas-mcp-copilot on 2026-10-07: document origin, local changes and current integration behavior. -->
# Atlas MCP Copilot

## Origin, license and modifications

This repository is maintained by [surplus96](https://github.com/surplus96) and is
based on [GabrielGB1999/Atlas-MCP](https://github.com/GabrielGB1999/Atlas-MCP).
The original Git history is retained. The upstream baseline for these changes is
[`fabced6`](https://github.com/GabrielGB1999/Atlas-MCP/commit/fabced6129df073f4a5808b5d2e43095d60f0da6).

The original [Apache License 2.0](LICENSE) is retained, together with existing
attribution notices. Modified files carry change notices identifying this
repository's changes; newly added implementation and test files are also marked.

Changes made for the [Uptime Copilot](https://github.com/surplus96/uptime-copilot)
integration include:

- Required MCP bearer authentication and validation of allowed Host headers.
- A non-root Docker process and a host endpoint bound to `127.0.0.1:3100`.
- Structured procedure Tasks and evidence notes, with existing tasks, operator
  notes and recorded results preserved when the same procedure is registered again.
- No automatic transient retry of work-order creation after an ambiguous failure.
- Regression tests for task registration and work-order creation retry behavior.

The Copilot application manages approval, persistent delivery IDs and partial-delivery
retries. This MCP repository supplies the Atlas REST API tools used by that application.

## Overview

An MCP (Model Context Protocol) server that bridges Claude to the [Atlas CMMS](https://github.com/grashjs/cmms)
work order REST API, exposed over Streamable HTTP.

It signs in to the API once with a service-account email/password, holds the resulting JWT in
memory, and refreshes it automatically (both preemptively before expiry and reactively on a 401).

## Tools

| Tool | Endpoint | Purpose |
|---|---|---|
| `list-work-orders` | `POST /work-orders/search` | Filter + paginate work orders |
| `get-work-order` | `GET /work-orders/{id}` | Full detail on one work order |
| `create-work-order` | `POST /work-orders` | Create a work order |
| `update-work-order` | `PATCH /work-orders/{id}` | Partial update of general fields |
| `change-work-order-status` | `PATCH /work-orders/{id}/change-status` | Move through OPEN/IN_PROGRESS/ON_HOLD/COMPLETE, with feedback/signature |
| `assign-work-order` | (wraps `update-work-order`) | Set assignees / primary assignee |
| `generate-weekly-work-order-report` | `POST /work-orders/search` (paged) | Executive summary for a given week, by `dueDate` |
| `get-asset` | `GET /assets/{id}` | Full detail on one asset, read-only |
| `list-assets` | `POST /assets/search` | Filter + paginate assets, read-only |
| `add-work-order-tasks` | `GET/PATCH /tasks/work-order/{id}`, `GET/PATCH /tasks/{taskId}` | Add procedure tasks and evidence notes while preserving existing operator data |
| `get-work-order-tasks` | `GET /tasks/work-order/{id}` | Read task definitions, notes and recorded results |

Task tools use the numeric `workOrderId` returned by `create-work-order`. Their task
results include Atlas task DTOs and numeric task IDs for follow-up operations.
`add-work-order-tasks` accepts unique labels, `taskType: "SUBTASK"`, `options: []`
and optional `notes`. It verifies saved tasks and notes before returning `verified: true`.
Adding procedure tasks does not attach or consume inventory parts.

### Output matches what a human sees in the frontend, not the database schema

The original work-order and asset tools render people and entities as `{ id, name }` pairs instead of bare ids —
`get-work-order`'s `relations.primaryWorker` reads `{ "id": 7, "name": "John Smith" }`, not
`"worker: ID 225"`. Two conventions apply everywhere, and are also declared in the MCP server's
`instructions` field (sent once at connection time) so Claude applies them without being told
per-request:

- **`id` is the display code, not the database primary key.** The frontend's own "Id" column is
  always bound to `customId` (`WorkOrderService.getWorkOrderNumber` / `AssetService.getAssetNumber`
  — format `WO` + 6 digits for work orders, e.g. `WO000042`; `A` + 6 digits for assets, e.g.
  `A000012`), never the raw numeric id — confirmed in both the generation code and the
  list/detail-view rendering. So every tool's `id` field is that display code
  (`src/util/format.ts`'s `displayId()`), and the raw numeric id — still needed to chain further
  tool calls — is kept alongside under an unambiguous name: `workOrderId` for work orders,
  `assetId` for assets. Never read a bare number back to a user as "the ID".
- **`primaryWorker` is the main/responsible worker, distinct from `assignedTo`.** The frontend
  detail page (`WorkOrderDetails.tsx`) renders `primaryUser` under its own "Primary Worker"
  heading, with its own "No primary worker" empty state — structurally separate from the
  "Assigned To" list of other workers, never merged into it. So when asked "who is working on
  this" or "who's assigned to it", answer with `primaryWorker` first; `assignedTo` is the
  additional-workers list, not a set of equally-weighted assignees.

Two more wrinkles worth knowing:

- **Users have no combined "name" field on the API side** (`UserMiniDTO` only has
  `firstName`/`lastName`) — `formatUserName()` joins them. A user with neither field set (rare)
  falls back to `User #<id>`.
- **`get-work-order` also fetches and resolves discrepancies** ("squawks") via
  `GET /work-order-discrepancies/work-order/{id}`, included as a `discrepancies` array. Each
  discrepancy's "raised by" is only exposed as a raw `createdBy` user id by that endpoint — this
  tool makes one extra `GET /users/{id}` call per unique id to resolve it to a name
  (`src/util/userLookup.ts`), rather than showing a bare id.

### A few things that don't match the "obvious" naming

The Atlas API's actual enums differ from what you'd guess from a typical CMMS:

- **Status** is `OPEN | IN_PROGRESS | ON_HOLD | COMPLETE` — there is no `ARCHIVED` status.
  `archived` is a separate boolean field, set via `update-work-order`, not a status value.
- **Priority** is `NONE | LOW | MEDIUM | HIGH` (note `NONE`, the default).
- **AssetStatus** (settable on create via `assetStatus`) is `OPERATIONAL | DOWN | MODERNIZATION |
  STANDBY | INSPECTION_SCHEDULED | COMMISSIONING | EMERGENCY_SHUTDOWN`.
- `change-work-order-status` has no `completedById` — the API sets `completedBy`/`completedOn`
  itself when a work order reaches `COMPLETE`; this tool only sends `status`, `feedback`, and
  `signature`.

These were verified against the API's actual Java source (entities/DTOs/enums), not assumed from
convention — see `src/atlasTypes.ts` for the mirrored shapes.

### Search filter mechanics

The API's `/work-orders/search` endpoint takes a `SearchCriteria` with a `filterFields` array, and
its filter semantics are stricter than they look:

- Filtering an **enum column** (`status`, `priority`) requires `operation: "in"` with `enumName` set
  (`"STATUS"` / `"PRIORITY"`) and the value(s) in `values`. A plain `"eq"` with a bare string skips
  the server's enum-name conversion and won't match anything.
- Filtering a **to-many relation** (`assignedTo`) requires `operation: "inm"` (many-to-many, via a
  join) with `joinType: "LEFT"`.
- Filtering a **to-one relation** (`team`, `location`) uses `operation: "in"` on the bare field name
  with entity ids in `values`.
- **`list-assets` deliberately has no status filter.** The server's enum-name conversion
  (`EnumName.java`) only knows `PRIORITY`/`STATUS`/`JS_DATE` — there's no `ASSET_STATUS` entry, and
  the API's own frontend doesn't filter assets by status via search either. Filtering by status
  would silently match nothing rather than erroring, so it's left out; use `get-asset` on
  individual results instead.
- Filtering a **date range** requires `operation: "ge"`/`"le"` with `enumName: "JS_DATE"`, and the
  value must be in the *exact* format `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` — i.e. JavaScript's
  `Date#toISOString()`. Any other format fails to parse server-side and is silently dropped (no
  error), so the filter just doesn't apply.

`list-work-orders` and `generate-weekly-work-order-report` build these correctly; if you extend the
filter set, mirror this rather than guessing at `"eq"`.

## Setup

```bash
cp .env.example .env   # fill in API_BASE_URL / API_EMAIL / API_PASSWORD
npm install
npm run build
npm start
```

For local development against a running Atlas API:

```bash
npm run dev
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `API_BASE_URL` | `http://localhost:8080` | Base URL of the Atlas API |
| `API_EMAIL` | *(required)* | Service account email |
| `API_PASSWORD` | *(required)* | Service account password |
| `MCP_PORT` | `3000` | Port for the MCP HTTP transport + `/health` |
| `LOG_LEVEL` | `INFO` | `DEBUG \| INFO \| WARN \| ERROR` |
| `JWT_EXPIRY_BUFFER_MINUTES` | `5` | Refresh the JWT this many minutes before it expires |
| `MCP_AUTH_TOKEN` | *(required)* | Bearer token required on `/mcp`; startup fails if unset |
| `ALLOWED_HOSTS` | *(empty)* | Extra accepted Host-header values, comma-separated; include the port when present in the request |

The service account must already exist (`POST /auth/signup` against the Atlas API) before this
server starts — it only signs in, it doesn't create the account.

## Exposing this on a public network

Local Claude clients (Desktop, Claude Code) can reach `localhost` directly. The Claude mobile apps
and claude.ai's custom connectors cannot — they need a public HTTPS URL. Before you put this
server anywhere reachable from the internet:

1. **Set `MCP_AUTH_TOKEN`** to a long random value (`openssl rand -hex 32`). This fork requires
   it even for local development and refuses to start without it.
2. **Put it behind HTTPS** — a reverse proxy (Caddy, nginx + Let's Encrypt) or a platform that
   terminates TLS for you (Fly.io, Render, etc.).
3. When adding it as a custom connector in claude.ai, supply the same token as the connector's
   bearer/auth header.
4. Set `ALLOWED_HOSTS` to the Host-header value forwarded by your proxy.

`GET /health` intentionally stays open with no token required, so container orchestrators and load
balancers can probe it without the secret.

## Running with Docker

```bash
docker compose up -d --build
```

`docker-compose.yml` reads `API_BASE_URL`, `API_EMAIL`, `API_PASSWORD`, `LOG_LEVEL`,
`JWT_EXPIRY_BUFFER_MINUTES`, `MCP_AUTH_TOKEN`, and `ALLOWED_HOSTS` from your shell/`.env`.
The host MCP endpoint is `http://127.0.0.1:3100/mcp`; the container listens on port 3000.
For local clients using that host endpoint, set `ALLOWED_HOSTS=127.0.0.1:3100,localhost:3100`
as appropriate. The container exposes
`GET /health` → `{ "status": "ok" }`, used by both the Dockerfile's `HEALTHCHECK` and the compose
file.

## Example tool calls

```json
// list-work-orders
{ "status": ["OPEN", "IN_PROGRESS"], "priority": ["HIGH"], "pageSize": 10 }

// get-work-order
{ "workOrderId": 42 }

// create-work-order
{
  "title": "Replace worn belt",
  "description": "Belt on conveyor 3 is fraying",
  "priority": "HIGH",
  "dueDate": "2026-09-05T00:00:00Z",
  "assetId": 12,
  "assignedToUserIds": [7, 9]
}

// update-work-order
{ "workOrderId": 42, "priority": "MEDIUM", "estimatedDuration": 1.5 }

// change-work-order-status
{ "workOrderId": 42, "newStatus": "COMPLETE", "feedback": "Replaced and tested." }

// assign-work-order
{ "workOrderId": 42, "userIds": [7, 9], "primaryUserId": 7 }

// generate-weekly-work-order-report
{ "weekOffset": 0, "format": "MARKDOWN" }

// get-asset
{ "assetId": 12 }

// list-assets
{ "locationId": 3, "nameContains": "conveyor", "pageSize": 10 }
```

## Testing

```bash
npm test
```

- `test/validation.test.ts` — pure input-validation unit tests (malformed dates, bad enums,
  missing required fields, oversized arrays). Runs with no network access.
- `test/integration.test.ts` — exercises the real API end to end (signin → list → create → get →
  update → change-status). Only runs when `API_BASE_URL`, `API_EMAIL`, and `API_PASSWORD` are set
  and point at a live instance with that account already signed up; otherwise the suite is skipped
  so `npm test` still passes in CI without a backend.

To stand up a local Atlas API to test against, see the `cmms` repo's own `CLAUDE.md` — the short
version:

```bash
service postgresql start
su postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD 'postgres';\" -c 'CREATE DATABASE atlas;'"
cd api && DB_URL=localhost:5432/atlas DB_USER=postgres DB_PWD=postgres \
  JWT_SECRET_KEY=... KEYGEN_PRODUCT_TOKEN= OAUTH2_PROVIDER= STORAGE_TYPE=minio \
  mvn -DskipTests spring-boot:run

curl -X POST localhost:8080/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"mcp@atlas.local","password":"Password123!","firstName":"MCP","lastName":"Bot","phone":"+1","companyName":"Co","employeesCount":2}'
```

Then set `API_EMAIL=mcp@atlas.local`, `API_PASSWORD=Password123!` before running `npm test`.

## Error handling & logging

- **401** → the client re-authenticates once and retries the request; a second 401 is surfaced as
  an error rather than retried again.
- **Transient errors** (5xx, network/timeout) → retried up to 3 times with backoff `100ms → 500ms →
  1000ms`, except `POST /work-orders`. Creation failures are surfaced without automatic transient
  retries because Atlas may have saved the order before the response was lost.
- All logging is structured JSON on stdout/stderr. `password`, `accessToken`, `authorization`, and
  `signature` fields are redacted from logged context, at every log level, so raising `LOG_LEVEL` to
  `DEBUG` never leaks a credential or token.

## Troubleshooting

- **"Missing required environment variable: API_EMAIL/API_PASSWORD"** — set them in `.env` or the
  environment; the process refuses to start without them (no hardcoded fallback).
- **Every tool call fails with a 401-related error** — the service account may not exist yet, or
  its password changed. Re-run `/auth/signup` (or reset the password) against the Atlas API.
- **`list-work-orders` returns nothing you expect from a status/priority filter** — double-check
  you're not comparing against `ARCHIVED` as a status (it isn't one) — see
  [Tools](#a-few-things-that-dont-match-the-obvious-naming) above.
- **`generate-weekly-work-order-report` looks incomplete for a busy week** — it pages through
  results up to 25 pages of 200 (5,000 work orders); past that it logs a `WARN` and returns what it
  has rather than hanging indefinitely.
- **`/mcp` requests return 401 "missing or invalid bearer token"** — `MCP_AUTH_TOKEN` is set on the
  server; the client must send the exact same value as `Authorization: Bearer <token>`.
- **Startup fails with `Missing required environment variable: MCP_AUTH_TOKEN`** — set a
  bearer token in `.env` or the environment before starting the server.
- **`/mcp` requests return 421** — add the legitimate request Host-header value to
  `ALLOWED_HOSTS`, including its port if supplied.
