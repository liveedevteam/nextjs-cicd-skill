# nextjs-cicd — Claude Code Skill

A Claude Code skill that sets up and audits a production-grade CI/CD pipeline for **Next.js + Vercel** projects using GitHub Actions — with battle-tested rules baked in so you don't hit common pitfalls.

**Homepage:** https://liveedevteam.github.io/nextjs-cicd-skill/

---

## Install

### Option A — npx (quickest)

```bash
npx nextjs-cicd-skill
```

Copies the skill into `~/.claude/skills/nextjs-cicd/` and prints usage instructions.

### Option B — Claude Code plugin

Add to `~/.claude/settings.json`:

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

Then install:

```
/plugin install nextjs-cicd@nextjs-cicd
```

---

## Usage

In any Next.js project conversation, type:

```
/nextjs-cicd
```

The skill activates automatically when you ask Claude to:
- Set up CI/CD for a Next.js project
- Fix a failing CI job or debug deploy timing issues
- Add Playwright E2E tests, Vitest unit tests, or knip dead-code scanning
- Add env var validation
- Audit an existing GitHub Actions pipeline

---

## What it covers

### Install mode
Sets up a complete pipeline from scratch:

| File | Purpose |
|---|---|
| `.github/workflows/ci.yml` | 6 parallel gate jobs |
| `.github/workflows/deploy.yml` | Tag-based deploy triggered by CI success |
| `.github/workflows/_deploy-vercel.yml` | Reusable Vercel deploy workflow |
| `.github/actions/setup-node/action.yml` | Composite Node setup action |
| `vitest.config.ts` | Unit test config |
| `src/test/setup.ts` | Vitest setup file |
| `playwright.config.ts` | E2E test config |
| `knip.config.ts` | Dead-code scan config |
| `scripts/validate-env.ts` | Zod env var validation |

### Audit mode
Diagnoses problems in existing pipelines:

| Symptom | Root cause identified |
|---|---|
| Deploy ran before CI finished | Wrong trigger (`push` instead of `workflow_run`) |
| Deploy ran twice | Unconditional `cancel-in-progress` |
| Knip false positives | Missing entry points in config |
| Semgrep blocking merges | `continue-on-error` missing |
| Build fails on CI only | Missing build-time env vars |
| E2E runs on every push | Missing `pull_request` guard |

---

## Hard-won rules baked in

| Rule | Why it matters |
|---|---|
| No `${{ }}` in `run:` steps | Shell injection prevention |
| `npm ci --include=optional` | Preserves lockfile determinism; fixes cross-platform native binding failures |
| Deploy via `workflow_run`, never on push | Prevents deploys before CI finishes |
| `cancel-in-progress` is conditional | Tag deploys must never be cancelled mid-flight |
| `permissions:` block on every workflow | Without it, `GITHUB_TOKEN` inherits repo-wide write access |
| `workflows: [CI]` must match exactly | Name mismatch silently breaks deploy trigger |
| `vercel pull` writes to `.vercel/.env.production.local` | Not `.env.local` — both must be loaded |

---

## GitHub Secrets required after setup

| Secret | Purpose |
|---|---|
| `VERCEL_TOKEN` | Vercel CLI auth |
| `VERCEL_ORG_ID` | Vercel org |
| `VERCEL_PROJECT_ID` | Vercel project |
| `E2E_ADMIN_EMAIL` | Playwright test account (dev env) |
| `E2E_ADMIN_PASSWORD` | Playwright test account (dev env) |

| Variable | Purpose |
|---|---|
| `VERCEL_ALIAS_DEV` | Base URL for E2E tests on PRs |

---

## Deployment

Once the pipeline is installed, deploy by pushing a version tag:

```bash
# Production
git tag prd/v1.0.0 && git push origin prd/v1.0.0

# UAT
git tag uat/v0.1.0 && git push origin uat/v0.1.0

# Dev
git tag dev/v0.1.0 && git push origin dev/v0.1.0
```

CI runs → on success → deploy fires automatically for the matching environment.

---

## License

Apache 2.0 — see [LICENSE](LICENSE)

[Privacy Policy](https://liveedevteam.github.io/nextjs-cicd-skill/privacy.html)
