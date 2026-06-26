---
name: nextjs-cicd
description: "Set up, audit, or fix a production-grade CI/CD pipeline for a Next.js + Vercel project. Use when the user asks to add CI/CD, set up GitHub Actions, configure Vercel deploy workflows, add Playwright or Vitest, fix a failing CI job, or debug deploy timing issues (deploy ran before CI, deploy ran twice, semgrep blocking merges, knip false positives)."
---

# Next.js CI/CD Pipeline Skill

## Modes

This skill covers two scenarios. Identify which applies before acting:

- **Install mode** — project has no CI/CD yet → copy files, install deps, print next steps
- **Audit mode** — project already has workflows → diagnose and fix problems

---

## Non-negotiable rules

### 1. No shell injection — never put `${{ }}` in `run:` steps

```yaml
# WRONG
- run: vercel deploy --token="${{ secrets.VERCEL_TOKEN }}"

# CORRECT
- env:
    VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
  run: vercel deploy --token="$VERCEL_TOKEN"
```

### 2. Use `npm ci --include=optional`, not plain `npm ci` in CI

Plain `npm ci` skips optional dependencies, which breaks cross-platform native bindings (e.g. a package compiled for macOS arm64 won't exist in the Linux x64 runner's lockfile). The `--include=optional` flag preserves lockfile determinism while ensuring optional deps are installed:

```bash
npm ci --include=optional
```

Do not fall back to `npm install` — it sacrifices lockfile determinism. Always use `npm ci --include=optional` in the composite setup-node action.

### 3. Deploy triggers on CI completion (`workflow_run`), never on push

Deploy only fires when CI succeeds:

```yaml
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
```

All deploy jobs must check:
```yaml
if: github.event.workflow_run.conclusion == 'success'
```

### 4. Tag-based deploys must never be cancelled mid-flight

`cancel-in-progress` must be conditional — only cancel PR previews, never tag deploys:

```yaml
concurrency:
  group: deploy-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: ${{ github.event.workflow_run.event == 'pull_request' }}
```

### 5. `vercel pull` writes to a non-obvious path

```typescript
// CI: vercel pull --environment=production writes here:
config({ path: ".vercel/.env.production.local" })
// Local dev fallback:
config({ path: ".env.local" })
```

### 6. `workflow_run` depends on the CI workflow's `name:` matching exactly

`deploy.yml` listens for:

```yaml
on:
  workflow_run:
    workflows: [CI]
```

This matches the `name:` field at the top of `ci.yml`. If the CI workflow is named anything other than `CI` (e.g. `"Continuous Integration"`, `"ci"`), the deploy workflow **silently never triggers** — no error, no warning. Always verify both files use the same string.

### 7. Use least-privilege `permissions:` on all workflows

Always declare the minimum `GITHUB_TOKEN` permissions needed. Default permissions are too broad. For CI:

```yaml
permissions:
  contents: read

jobs:
  ...
```

For the deploy workflow (needs to post PR comments):

```yaml
permissions:
  contents: read
  pull-requests: write
  statuses: read

jobs:
  ...
```

Never omit the `permissions:` block — without it the token inherits repository-wide write access.

### 8. `vercel` CLI version pin

Templates use `npx vercel@54`. This is pinned for reproducibility — unpinned `npx vercel` can pull a breaking major version mid-flight. When upgrading, check the [Vercel CLI changelog](https://github.com/vercel/vercel/releases) and pin to the new major explicitly.

---

## Audit checklist (use when pipeline already exists)

When the user reports a problem, check these before suggesting changes:

| Symptom | What to check |
|---|---|
| Deploy ran before CI finished | `deploy.yml` uses `workflow_run`, not `push`/`tag`? All jobs check `conclusion == 'success'`? |
| Deploy ran twice | Concurrency group includes branch name? `cancel-in-progress` is conditional (not `true`)? |
| `npm audit` blocking merges | Run `npm audit --audit-level=high` locally — is it a real vuln or a false positive? Use `npm audit fix` or add an `overrides` entry in `package.json` |
| `knip` reporting false positives | Check `entry` patterns cover all framework entry points; add false-positive exports to `ignore` or `ignoreDependencies` |
| `semgrep` blocking merges | `continue-on-error: true` should be set until baseline triage is complete — flip it back |
| E2E running on push to main | `e2e` job must have `if: github.event_name == 'pull_request'` |
| Shell injection warning | Move `${{ }}` expressions out of `run:` into `env:` blocks |
| `${{ }}` in `run:` not expanding | Expression must be in `env:` — see rule 1 |

---

## CI gate jobs (all run in parallel)

| Job | Command | Blocks deploy |
|---|---|---|
| `lint-and-build` | `npm run lint && npm run type-check && npm run build` | Yes |
| `unit-tests` | `npm test` | Yes |
| `dependency-scan` | `npm audit --audit-level=high` | Yes |
| `knip` | `npm run knip` | Yes |
| `semgrep` | semgrep-action with `p/typescript p/react p/nextjs p/secrets p/owasp-top-ten` | No (`continue-on-error: true`) until baseline triage |
| `e2e` | `npm run test:e2e` | Yes — PRs only (`if: github.event_name == 'pull_request'`) |

> `semgrep` starts as non-blocking. Flip `continue-on-error` to `false` after the team triages the first run's findings.

---

## Deployment environments

Tag prefix determines environment:

| Tag prefix | Environment | Vercel target |
|---|---|---|
| `prd/v*` | Production | `--prod` flag |
| `uat/v*` | UAT | preview (no `--prod`) |
| `dev/v*` | Development | preview (no `--prod`) |
| PR | Preview | preview |

Deploy flow:
1. Push a tag → CI runs
2. CI passes → `deploy.yml` fires via `workflow_run`
3. Correct deploy job runs based on tag prefix

---

## Required files

### Composite action: `.github/actions/setup-node/action.yml`

```yaml
name: Setup Node.js
description: Set up Node.js with npm caching

inputs:
  node-version:
    required: false
    default: ""
  install-dependencies:
    required: false
    default: "true"

runs:
  using: composite
  steps:
    - name: Setup Node.js ${{ inputs.node-version }}
      uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}
        node-version-file: ${{ inputs.node-version == '' && '.nvmrc' || '' }}
        cache: "npm"

    - name: Install dependencies
      if: inputs.install-dependencies == 'true'
      shell: bash
      run: npm ci --include=optional
```

### CI workflow: `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
    tags:
      - "dev/v*"
      - "uat/v*"
      - "prd/v*"
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-and-build:
    name: Lint & Build
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - run: npm run lint
      - run: npm run type-check
      - run: npm run build
        env:
          # Add dummy values for env vars your project requires at build time.
          # Ask the user which vars Next.js needs at build (not runtime) and add them here.
          # Example:
          # DATABASE_URL: dummy://localhost/dummy
          # AUTH_SECRET: dummy-secret-for-build-only

  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - run: npm test

  dependency-scan:
    name: Dependency Scan
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - run: npm audit --audit-level=high

  knip:
    name: Knip — Dead Code
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - run: npm run knip

  semgrep:
    name: Semgrep — Security Scan
    runs-on: ubuntu-latest
    timeout-minutes: 10
    continue-on-error: true  # flip to false after baseline triage
    steps:
      - uses: actions/checkout@v4
      - uses: semgrep/semgrep-action@v1
        with:
          config: >-
            p/typescript
            p/react
            p/nextjs
            p/secrets
            p/owasp-top-ten

  e2e:
    name: E2E Tests
    runs-on: ubuntu-latest
    timeout-minutes: 20
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - run: npx playwright install chromium --with-deps
      - run: npm run test:e2e
        env:
          PLAYWRIGHT_BASE_URL: ${{ vars.VERCEL_ALIAS_DEV && format('https://{0}', vars.VERCEL_ALIAS_DEV) || 'http://localhost:3000' }}
          E2E_ADMIN_EMAIL: ${{ secrets.E2E_ADMIN_EMAIL }}
          E2E_ADMIN_PASSWORD: ${{ secrets.E2E_ADMIN_PASSWORD }}
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

### Deploy workflow: `.github/workflows/deploy.yml`

```yaml
name: Deploy to Vercel

on:
  workflow_run:
    workflows: [CI]
    types: [completed]

concurrency:
  group: deploy-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: ${{ github.event.workflow_run.event == 'pull_request' }}

jobs:
  preview:
    name: Preview
    runs-on: ubuntu-latest
    if: |
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'pull_request'
    uses: ./.github/workflows/_deploy-vercel.yml
    with:
      vercel-environment: preview
      ref: ${{ github.event.workflow_run.head_sha }}
    secrets: inherit

  comment-preview-url:
    name: Comment Preview URL
    runs-on: ubuntu-latest
    needs: preview
    if: |
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'pull_request'
    steps:
      - uses: actions/github-script@v7
        env:
          PREVIEW_URL: ${{ needs.preview.outputs.deployment-url }}
        with:
          script: |
            const pr = context.payload.workflow_run.pull_requests[0]
            if (!pr) return
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: pr.number,
              body: [
                '## Preview Deployment',
                `**URL:** ${ process.env.PREVIEW_URL }`,
                `**Commit:** ${context.payload.workflow_run.head_sha.slice(0, 7)}`
              ].join('\n')
            })

  production:
    name: Production / Deploy
    runs-on: ubuntu-latest
    if: |
      github.event.workflow_run.conclusion == 'success' &&
      startsWith(github.event.workflow_run.head_branch, 'prd/v')
    uses: ./.github/workflows/_deploy-vercel.yml
    with:
      vercel-environment: production
      ref: ${{ github.event.workflow_run.head_branch }}
    secrets: inherit

  uat:
    name: UAT
    runs-on: ubuntu-latest
    if: |
      github.event.workflow_run.conclusion == 'success' &&
      startsWith(github.event.workflow_run.head_branch, 'uat/v')
    uses: ./.github/workflows/_deploy-vercel.yml
    with:
      vercel-environment: preview
      ref: ${{ github.event.workflow_run.head_branch }}
    secrets: inherit

  development:
    name: Development
    runs-on: ubuntu-latest
    if: |
      github.event.workflow_run.conclusion == 'success' &&
      startsWith(github.event.workflow_run.head_branch, 'dev/v')
    uses: ./.github/workflows/_deploy-vercel.yml
    with:
      vercel-environment: preview
      ref: ${{ github.event.workflow_run.head_branch }}
    secrets: inherit
```

### Reusable deploy: `.github/workflows/_deploy-vercel.yml`

```yaml
name: Deploy to Vercel (reusable)

on:
  workflow_call:
    inputs:
      vercel-environment:
        required: true
        type: string
      ref:
        required: false
        type: string
        default: ""
    outputs:
      deployment-url:
        value: ${{ jobs.deploy.outputs.deployment-url }}

jobs:
  deploy:
    name: Deploy
    runs-on: ubuntu-latest
    timeout-minutes: 15
    outputs:
      deployment-url: ${{ steps.deploy.outputs.deployment-url }}

    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.ref }}

      - uses: ./.github/actions/setup-node
        with:
          install-dependencies: "false"

      - name: Pull Vercel project settings
        env:
          VERCEL_ENVIRONMENT: ${{ inputs.vercel-environment }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
        run: npx vercel@54 pull --yes --environment="$VERCEL_ENVIRONMENT" --token="$VERCEL_TOKEN"

      - name: Build
        env:
          VERCEL_ENVIRONMENT: ${{ inputs.vercel-environment }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
        run: |
          FLAG=$([[ "$VERCEL_ENVIRONMENT" == "production" ]] && echo "--prod" || echo "")
          npx vercel@54 build $FLAG --token="$VERCEL_TOKEN"

      - name: Deploy
        id: deploy
        env:
          VERCEL_ENVIRONMENT: ${{ inputs.vercel-environment }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          INPUT_REF: ${{ inputs.ref }}
        run: |
          FLAG=$([[ "$VERCEL_ENVIRONMENT" == "production" ]] && echo "--prod" || echo "")
          URL=$(npx vercel@54 deploy --prebuilt $FLAG --token="$VERCEL_TOKEN")
          echo "deployment-url=$URL" >> "$GITHUB_OUTPUT"
          TAG="$INPUT_REF"
          VERSION="${TAG##*/}"
          echo "### Deployed \`$VERSION\` to $VERCEL_ENVIRONMENT" >> "$GITHUB_STEP_SUMMARY"
          echo "**URL:** $URL" >> "$GITHUB_STEP_SUMMARY"
```

---

## Testing config files

### `vitest.config.ts`

```typescript
import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
})
```

### `src/test/setup.ts`

```typescript
import "@testing-library/jest-dom"
```

### `playwright.config.ts`

```typescript
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.CI
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
      },
})
```

### `knip.config.ts`

Start with this generic Next.js baseline, then tailor `entry` to match the project's actual structure.

```typescript
import type { KnipConfig } from "knip"

const config: KnipConfig = {
  entry: [
    // Standard Next.js App Router entry points — adjust if the project uses /pages or a different src layout
    "src/app/**/{page,layout,route,loading,error,not-found}.{ts,tsx}",
    "src/app/api/**/*.ts",
    "app/**/{page,layout,route,loading,error,not-found}.{ts,tsx}",  // no src/ prefix variant
    "next.config.{ts,js,mjs}",
    "scripts/*.ts",
  ],
  project: [
    "src/**/*.{ts,tsx}",
    "app/**/*.{ts,tsx}",
    "scripts/**/*.ts",
  ],
  ignore: [
    // Add generated files, shadcn components, or other intentionally-unused exports here
    "src/components/ui/**",
  ],
  ignoreDependencies: [
    // Add packages that are used implicitly (e.g. peer deps, CLI tools, test utils)
    "@playwright/test",
  ],
}

export default config
```

**Common knip false positives and fixes:**

| False positive | Fix |
|---|---|
| Auth config file (e.g. `auth.ts`) reported as unused | Add `"src/lib/auth.ts"` to `entry` |
| shadcn/ui components flagged | Add `"src/components/ui/**"` to `ignore` |
| Test utilities flagged | Add to `ignoreDependencies` |
| API route handlers not detected | Ensure `src/app/api/**/*.ts` pattern covers the project's actual path |

---

## `scripts/validate-env.ts`

**Before writing this file**, scan the project for env var usage:
- Read `next.config.ts` / `next.config.js` for `env:` and `publicRuntimeConfig`
- Grep for `process.env.` across `src/` to find all referenced vars
- Check `.env.example` if it exists

Then fill in the Zod schema with the vars you find.

```typescript
import { config } from "dotenv"
import { z } from "zod"

// vercel pull --environment=production writes here; fall back to .env.local for local dev
config({ path: ".vercel/.env.production.local" })
config({ path: ".env.local" })

const envSchema = z.object({
  // Fill in the project's required runtime env vars discovered from the codebase.
  // Examples:
  // DATABASE_URL: z.string().min(1),
  // AUTH_SECRET: z.string().min(1),
  // NEXT_PUBLIC_API_URL: z.string().url(),
})

const result = envSchema.safeParse(process.env)

if (!result.success) {
  console.error("❌ Environment variable validation failed:\n")
  for (const [field, issues] of Object.entries(result.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${issues?.join(", ")}`)
  }
  console.error("\nEnsure all required variables are set in Vercel or .env.local.")
  process.exit(1)
}

console.log("✅ All required environment variables are present.")
```

---

## `package.json` scripts to add

```json
{
  "scripts": {
    "validate-env": "tsx scripts/validate-env.ts",
    "knip": "knip",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

Merge additively — never remove existing scripts.

## Dev dependencies to install

```bash
npm install -D knip vitest @vitest/coverage-v8 jsdom @testing-library/jest-dom @playwright/test dotenv
```

---

## Troubleshooting common gate failures

### `npm audit` fails
```bash
npm audit --audit-level=high   # reproduce locally
npm audit fix                  # auto-fix if possible
```
If it's a transitive dep with no fix yet, add a `overrides` entry in `package.json` to force a safe version, or use `npm audit --ignore` for known false positives.

### `knip` fails immediately
Most likely the `entry` patterns don't match the project's file structure. Check:
1. Does the project use `src/app/` or `app/` (no src prefix)?
2. Are there non-standard entry points (auth config, middleware, instrumentation)?
Add them to `entry` in `knip.config.ts`.

### `semgrep` blocking merges
Set `continue-on-error: true` on the semgrep job until the team does a baseline triage run. Only remove it after all existing findings are either fixed or suppressed with `# nosemgrep`.

### E2E tests fail on CI but pass locally
Check:
1. `PLAYWRIGHT_BASE_URL` — is `VERCEL_ALIAS_DEV` set in GitHub Variables?
2. `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` — are they set in GitHub Secrets?
3. Is the dev deployment URL correct and publicly reachable?

### Build fails on CI but works locally
Almost always a missing build-time env var. Add a dummy value in the `lint-and-build` job's `env:` block. Check `next.config.ts` for any vars accessed at build time (outside of `getServerSideProps` / server components).

---

## GitHub Secrets to register after setup

### Secrets (Settings → Secrets and variables → Actions → Secrets)

| Secret | Purpose |
|---|---|
| `VERCEL_TOKEN` | Vercel CLI auth |
| `VERCEL_ORG_ID` | Vercel org |
| `VERCEL_PROJECT_ID` | Vercel project |
| `E2E_ADMIN_EMAIL` | Playwright test account (dev env) |
| `E2E_ADMIN_PASSWORD` | Playwright test account (dev env) |

### Variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Purpose |
|---|---|
| `VERCEL_ALIAS_DEV` | Base URL for E2E tests on PRs |

---

## How to deploy

```bash
# Production
git tag prd/v1.0.0 && git push origin prd/v1.0.0

# UAT
git tag uat/v0.1.0 && git push origin uat/v0.1.0

# Dev
git tag dev/v0.1.0 && git push origin dev/v0.1.0
```

Monitor:
```bash
gh run list --repo <owner>/<repo> --limit 5
```

---

## When installing into a project

1. **Detect** — confirm `package.json` exists with `next` as a dependency; read `.nvmrc` for Node version
2. **Discover build-time env vars** — scan `next.config.ts` and grep `process.env.` across `src/` before writing `validate-env.ts`
3. **Check existing files** — never overwrite; print `⚠ skipped (already exists): <path>` for each conflict
4. **Copy workflow files** into `.github/workflows/` and `.github/actions/setup-node/`
5. **Copy test configs** — `vitest.config.ts`, `playwright.config.ts`, `knip.config.ts`, `src/test/setup.ts`
6. **Tailor `knip.config.ts`** — adjust `entry` paths to match the project's actual file structure
7. **Copy scripts** — `scripts/validate-env.ts` with env vars discovered in step 2
8. **Merge `package.json` scripts** — additive only, never remove existing scripts
9. **Install dev dependencies** — only those not already present
10. **Print next steps** — GitHub Secrets list, `VERCEL_ALIAS_DEV` variable, commit and push instructions
