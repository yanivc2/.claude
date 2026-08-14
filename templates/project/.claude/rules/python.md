---
paths:
  - "**/*.py"
  - "**/requirements.txt"
  - "**/pyproject.toml"
---

# Python

> **Applies to:** Python source and dependency manifests. Not relevant to
> TypeScript-only changes.

## Style

- Type hints on every function signature — parameters and return.
- `ruff` for linting, `black` for formatting. Formatting is tool-owned; don't
  hand-align.
- `pathlib.Path` over string path concatenation.
- f-strings over `%` and `.format()`.
- Module-level constants in `UPPER_SNAKE_CASE`; everything else `snake_case`.

## Structure

- A script that can be run needs `if __name__ == "__main__":` — never top-level
  side effects on import.
- Keep I/O at the edges: parsing, network, and file access in their own functions,
  pure logic in between. It is the difference between testable and not.
- One virtualenv per project (`.venv/`), never a global install. Pin versions in
  `requirements.txt` or `pyproject.toml`.

## Errors

- Never `except:` or `except Exception:` without re-raising or logging with context.
- Catch the specific exception you expect; let the rest propagate.
- Every outbound HTTP call gets an explicit `timeout=` — `requests` and `httpx`
  both wait forever by default, which is how a scraper silently hangs overnight.
- Retries with backoff for anything crossing the network; cap the attempts.

## Long-running agents and scrapers

- Log start, progress, and completion — an unattended run that prints nothing is
  indistinguishable from a hung one.
- Persist progress so a crash resumes instead of restarting.
- Browser automation (Playwright/Selenium): always close contexts in a `finally`,
  and treat any saved `storageState`/session file as a live credential — gitignore
  it, never log it.
