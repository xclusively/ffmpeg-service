# Security Policy

## Reporting a vulnerability

Do **not** open a public GitHub issue for a security problem. Report it privately
to **tech@xclusively.com** with:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected service(s), endpoint(s), and version/commit

We aim to acknowledge within **72 hours** and provide a remediation timeline based
on severity (Critical: 72h · High: 7d · Medium: 30d · Low: best-effort).

## Automated scanning (defense in depth)

Every change passes through layered, automated checks — no single tool is relied on:

| Layer                | Tool                                  | Where                                                                    |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| Secrets (pre-merge)  | **TruffleHog** (`--results=verified`) | GitHub Actions — `secret-scan.yml`, scans the PR diff, blocks merge      |
| Secrets (build-time) | **TruffleHog** (`--results=verified`) | Jenkins `Secret Scan` stage — scans the working tree before build/deploy |
| Dependencies         | **Dependabot** + `npm audit`          | Grouped weekly PRs + CI audit                                            |
| Lint / tests         | ESLint, Prettier, Jest                | GitHub Actions — `ci.yml`                                                |

Only **verified** (live, provider-validated) secrets fail a build, so random
high-entropy strings do not create noise — a real, active credential does.

## Runbook: the secret scan failed

A failing TruffleHog check means a **live** credential was detected. Treat it as
compromised the moment it touches a remote.

1. **Rotate first.** Immediately revoke/rotate the exposed credential at its
   provider (DB, Redis, CCBill, AWS, Hetzner, Dropbox, OAuth, SMTP, etc.).
   Assume it is already leaked — do not just delete the line.
2. **Remove it from the code.** Move the value into the runtime `.env` /
   Infisical (never committed) and re-push.
3. **Purge from history (if it was committed).** The CI gate scans only the diff,
   so a secret already in history will not fail new builds — but it is still
   exposed. Purge it with `git filter-repo` or BFG, then force-update the remote
   and re-run the one-time history scan:
   ```bash
   docker run --rm -v "$PWD:/repo" trufflesecurity/trufflehog:latest \
       git file:///repo --results=verified
   ```
4. **Confirm** the rotated credential works in staging before prod deploy.

## Handling secrets

- **Never commit** `.env`, `.env.*`, `.env.local`, keys, tokens, or credentials.
  These are provided at runtime via Infisical / `--env-file`; they are excluded
  by `.dockerignore` and must be `.gitignore`d.
- Configuration lives in the environment, not in source.

## Tooling notes

- TruffleHog runs as an **ephemeral** `docker run --rm` container (a scan job,
  not a long-running service) — the image is cached on the host and reused; only
  a short-lived container is created per run.
- For reproducible builds, pin the scanner image to a released version
  (e.g. `trufflesecurity/trufflehog:3.90.9`) instead of `:latest` once validated.
