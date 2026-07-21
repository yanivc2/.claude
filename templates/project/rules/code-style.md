# Code Style

> **Applies to:** every TypeScript/JavaScript file — always in effect.

## TypeScript

- Enable strict mode (`"strict": true` in tsconfig). No exceptions.
- No `any` — use `unknown` and narrow, or define a proper type.
- Prefer `type` over `interface` for shapes that won't be extended; use `interface` for public APIs that consumers may augment.
- Never use non-null assertion (`!`) on values you haven't verified are non-null.
- Prefer explicit return types on exported functions; infer for internal/trivial cases.

## Naming

- Files: `PascalCase` for components (`UserCard.tsx`), `camelCase` for utilities (`formatDate.ts`), `kebab-case` for route pages (`user-profile.tsx` in Next.js App Router).
- Variables/functions: `camelCase`.
- Constants and env config values: `SCREAMING_SNAKE_CASE`.
- Boolean variables/props: prefix with `is`, `has`, `can`, `should` (`isLoading`, `hasError`).
- Event handlers: prefix with `handle` (`handleSubmit`, `handleChange`).

## Imports

Order (separated by blank lines, no mixing):
1. Node built-ins (`node:path`, `node:fs`)
2. External packages (`react`, `next`, third-party libs)
3. Internal aliases (`@/lib/...`, `@/components/...`)
4. Relative imports (`../utils`, `./types`)

Use named exports everywhere. No default exports — they hurt refactoring and auto-import.

## Functions

- Small, single-purpose. If a function needs more than ~30 lines, look for an extraction.
- Prefer pure functions. Side effects should be at the boundary (event handlers, effects, API calls).
- No magic numbers — name them as constants.

## Comments

- Only for non-obvious *why*, never for *what*.
- No commented-out code — delete it, git has history.
- No TODO comments in committed code unless paired with a ticket reference.

## Formatting

- Prettier handles formatting — don't fight it.
- Max line length: 100 characters.
- Trailing commas in multi-line arrays/objects/params (Prettier default).
