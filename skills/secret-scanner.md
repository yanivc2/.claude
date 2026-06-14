---
name: "secret-scanner"
description: "A skill to identify, scan, and prevent committing sensitive credentials, passwords, API tokens, private keys, or certificates in the codebase. Use when doing security checks, verifying files before git commit, or auditing configuration files."
---

# Secret Scanner Skill

A specialized skill to audit codebases, configuration files, and git diffs for credentials, tokens, passwords, and private keys.

## Description

The `secret-scanner` skill provides a security auditing methodology to detect exposed secrets before they are committed to source control or deployed.

**What this skill does:**
1. **Identifies** high-entropy strings, known API token patterns, private keys, and passwords.
2. **Audits** configuration files (`.env`, `settings.json`, `config.yaml`, etc.) to ensure no production secrets are tracked.
3. **Recommends** remediation (e.g., using environment variables, secrets managers like AWS Secrets Manager, HashiCorp Vault, or GitHub Secrets).
4. **Validates** git ignore files (`.gitignore`) to ensure secret configuration patterns are excluded.

## Detected Secrets & Patterns

| Category | Typical Pattern / File Name | Risk Level | Description |
|---|---|---|---|
| **API Keys** | `sk_...` (OpenAI), `r8_...` (Replicate), `sk_live_...` (Stripe) | Critical | Access tokens to third-party services |
| **Passwords** | `password: "..."`, `db_password = "..."` | Critical | Plaintext credentials |
| **Private Keys** | `-----BEGIN RSA PRIVATE KEY-----` | Critical | Encryption keys, SSH keys |
| **Env Files** | `.env`, `.env.local`, `.env.production` | High | Configuration files containing local variables |
| **Certificates** | `.pem`, `.pfx`, `.crt` | High | TLS/SSL or code-signing certificates |

## Workflow

1. **Scan Files:** Search files in workspace or git staging area for strings matching keywords like `API_KEY`, `PASSWORD`, `SECRET`, `TOKEN`, `CREDENTIALS`, `PRIVATE KEY`.
2. **Assess Risk:** Identify if strings represent actual production keys, test tokens, or placeholders.
3. **Remediate:** Explain how to move the credentials to safe configuration variables.
4. **Ignore Check:** Verify that `.gitignore` properly covers files containing credentials.

## Remediations

- **Use Environment Variables:** Never hardcode secrets in source files. Reference them via `process.env` (JS/TS), `os.environ` (Python), or equivalent.
- **Git Ignore:** Add `.env`, `.env.*`, `secrets/`, and `deletions/` to `.gitignore`.
- **Remove Exposed Secrets from Git History:** If a secret is committed, invalidate it immediately, and rewrite git history using tools like `git-filter-repo` or `BFG Repo-Cleaner`.
