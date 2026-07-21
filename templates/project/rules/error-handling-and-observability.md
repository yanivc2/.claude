# Error Handling & Observability

> **Applies to:** error handling, logging, and monitoring — especially for long-running servers and background jobs.

## Error Handling

- Fail fast and loud in development; fail safe and informative in production.
- Catch errors where you can **do something** about them (retry, fallback, user message) — not everywhere. Let unexpected errors bubble to a central handler.
- Never swallow an error silently. An empty `catch {}` is a bug — at minimum log it with context.
- Throw `Error` objects (or typed subclasses), never strings — you lose the stack otherwise.
- Distinguish **expected** failures (validation, not-found, conflict) from **unexpected** ones (bugs, outages). Handle the first as normal flow; alert on the second.
- Every server needs one central error boundary/handler that maps errors to safe client responses and logs the internal detail.

## Logging

- Use a structured logger ({{LOGGER}} — e.g. `pino`/`winston`), not `console.log`. Emit JSON in production.
- Log **levels** deliberately: `error` (needs attention), `warn` (recoverable/degraded), `info` (key lifecycle events), `debug` (dev only).
- Every log line carries context: request id / correlation id, user id (not PII), operation, duration.
- Never log secrets, tokens, passwords, or PII — redact at the logger boundary (see `security.md`).
- Log the **why**, not just "error occurred": include the operation and the inputs that matter (sanitized).

## Monitoring & Alerting

- Send unhandled exceptions to an error-tracking service ({{ERROR_TRACKER}} — e.g. Sentry) with release + environment tags.
- Expose a `/health` (liveness) and, if the app has dependencies, a `/ready` (readiness) endpoint.
- Track the four signals that matter: error rate, latency (p95/p99), traffic, and saturation (CPU/memory/connections).
- Alert on symptoms users feel (error rate, latency) — not on every internal blip.

## Graceful Degradation

- A failing non-critical dependency should degrade one feature, not crash the app — isolate with timeouts and fallbacks.
- On shutdown, drain in-flight requests and close DB/queue connections cleanly (handle `SIGTERM`).

## Non-Negotiables

- No empty/silent catch blocks.
- No `console.log` for real logging.
- No secret or PII in a log line.
- Unhandled exceptions reach an error tracker, not `/dev/null`.
