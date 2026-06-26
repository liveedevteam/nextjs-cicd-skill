# nextjs-cicd — Claude Code Skill

A Claude Code skill that installs and audits a production-grade CI/CD pipeline for **Next.js + Vercel** projects using GitHub Actions.

## What it does

When invoked, Claude will set up or audit:

- **CI workflow** — 6 parallel gate jobs: lint & build, unit tests, dependency scan, dead-code (knip), security scan (semgrep), E2E tests (Playwright)
- **Deploy workflow** — tag-based deploys to dev / UAT / production, triggered only after CI passes
- **Reusable Vercel deploy workflow** — pull env vars, build, deploy, post preview URL as PR comment
- **Test configs** — Vitest (unit), Playwright (E2E), knip (dead code)
- **`scripts/validate-env.ts`** — Zod-based env var validation

## Install

Add this to your `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "nextjs-cicd": {
      "source": {
        "source": "github",
        "repo": "liveedevteam/nextjs-cicd-skill"
      }
    }
  }
}
```

Then install the skill:

```
/plugin install nextjs-cicd@nextjs-cicd
```

## Usage

In any Next.js project conversation:

```
/nextjs-cicd
```

## Critical rules baked in

- No shell injection — `${{ }}` expressions never go in `run:` steps
- `npm install` not `npm ci` (cross-platform optional deps)
- Deploy triggers on `workflow_run` (CI completion), never directly on push
- Tag-based deploys are never cancelled mid-flight
- `vercel pull` writes to `.vercel/.env.production.local`, not `.env.local`

## GitHub Secrets required after setup

| Secret | Purpose |
|---|---|
| `VERCEL_TOKEN` | Vercel CLI auth |
| `VERCEL_ORG_ID` | Vercel org |
| `VERCEL_PROJECT_ID` | Vercel project |
| `E2E_ADMIN_EMAIL` | Playwright test account |
| `E2E_ADMIN_PASSWORD` | Playwright test account |

| Variable | Purpose |
|---|---|
| `VERCEL_ALIAS_DEV` | Base URL for E2E tests on PRs |
