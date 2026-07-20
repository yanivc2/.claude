# Backend

> **Applies to:** server-side code — API routes/handlers, services, the data layer, background jobs. Fill in `{{BACKEND}}` stack specifics per project.

## API Design

- RESTful resources: nouns not verbs (`/users/:id`, not `/getUser`). Use HTTP verbs for intent (`GET`/`POST`/`PATCH`/`DELETE`).
- Return correct status codes: `200/201` success, `400` bad input, `401` unauthenticated, `403` unauthorized, `404` not found, `409` conflict, `422` validation, `500` server error.
- Consistent JSON envelope for errors: `{ error: { code, message } }` — stable `code`, human `message`, never a raw stack trace.
- Version public APIs (`/api/v1/...`) so you can evolve without breaking clients.
- Make mutating endpoints idempotent where possible (safe retries).

## Validation & Boundaries

- Validate every request (body, query, params) with a schema at the handler boundary — see `security.md`. The rest of the code may then assume typed, trusted data.
- Keep handlers thin: parse/authorize → call a service → shape the response. Business logic lives in services, not controllers.
- Separate layers: **route/controller → service → data-access**. No SQL/ORM calls inside route handlers.

## Data Layer

- All DB access goes through a repository/data-access module — no ad-hoc queries scattered across the codebase.
- Use parameterized queries / the ORM's safe API. Never string-concatenate SQL.
- Wrap multi-step writes in a transaction; make them atomic.
- Every schema change is a **migration**, committed to version control — never edit the DB by hand.
- Add indexes for the columns you filter/join on; avoid N+1 queries (batch or eager-load).

## Async & Reliability

- Set timeouts on every outbound call (DB, HTTP, queue). No unbounded waits.
- Retry only idempotent operations, with backoff and a cap. Don't retry `4xx`.
- Long/expensive work goes to a background job or queue, not the request path.
- Always release resources (connections, file handles) in `finally`/`using`.

## Configuration

- All config via environment variables, validated at startup — fail fast with a clear message if a required var is missing.
- No environment-specific values (URLs, keys) hard-coded in source.

## Non-Negotiables

- No business logic in route handlers.
- No raw, unparameterized queries.
- No schema change without a migration.
- No outbound call without a timeout.
