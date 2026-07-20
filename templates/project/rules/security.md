# Security

> **Applies to:** anything touching secrets, user input, auth, dependencies, or data leaving the process — API routes, forms, config, uploads, logging.

## Secrets & Config

- Never hard-code secrets, API keys, tokens, or connection strings. Read them from environment variables.
- Never commit `.env*` files. Keep `.env.example` with **keys only, no values**.
- Never log secrets, tokens, passwords, or full auth headers — redact before logging.
- Rotate any credential that was ever committed or pasted into a chat/PR — treat it as compromised.
- Least privilege: scope tokens (e.g. a GitHub PAT) to the minimum repos/permissions needed.

## Input Validation

- Validate and parse **all** external input at the boundary (request body, query, params, webhooks, file uploads) with a schema validator (e.g. `zod`). Reject, don't coerce silently.
- Treat every client-supplied value as hostile — including headers, cookies, and IDs.
- Enforce size and type limits on uploads and request bodies.
- Never build SQL, shell commands, or file paths by string-concatenating user input. Use parameterized queries and path allow-lists.

## AuthN / AuthZ

- Authentication (who you are) and authorization (what you may do) are separate — check both on every protected operation.
- Authorize on the **server**, per request. Never trust a client-side role/flag.
- Check ownership on every resource access (`can this user touch this record?`), not just "is logged in".
- Store passwords with a strong adaptive hash (`argon2`/`bcrypt`) — never plaintext, never fast hashes (MD5/SHA).
- Set cookies `HttpOnly`, `Secure`, `SameSite`; keep session/JWT lifetimes short and support revocation.

## Transport & Headers

- HTTPS everywhere. No secrets or tokens in URLs/query strings (they land in logs).
- Set security headers: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`.
- Lock CORS to an explicit origin allow-list — never reflect arbitrary origins or use `*` with credentials.

## Dependencies (Supply Chain)

- Run `{{PACKAGE_MANAGER}} audit` (or equivalent) before shipping; fix or consciously accept every high/critical finding.
- Commit the lockfile. Pin/verify new dependencies before adding them — check publisher, downloads, and recent activity.
- Avoid `postinstall` scripts from untrusted packages.

## Data Handling

- Collect the minimum PII needed; encrypt sensitive data at rest where the platform supports it.
- Return generic error messages to clients — never leak stack traces, SQL, or internal paths.
- Scrub secrets and PII from logs and error reports.

## Non-Negotiables

- No secret in git, ever.
- No unvalidated input reaching a query, command, or filesystem call.
- No authorization decision made on the client.
