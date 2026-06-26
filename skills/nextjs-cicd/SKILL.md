---
name: nextjs-cicd
description: "Set up or audit a production-grade CI/CD pipeline for a Next.js + Vercel project. Use when the user asks to add CI, GitHub Actions, deploy workflows, Playwright E2E tests, Vitest unit tests, knip dead-code scan, validate-env, or any part of the CI/CD pipeline. Also use when auditing or fixing existing workflow files."
---

# Next.js CI/CD Pipeline Skill

## What this skill covers

A complete CI/CD pipeline for Next.js projects deployed on Vercel, using GitHub Actions. The pipeline has two workflows:

1. **CI** (`ci.yml`) — runs on every push/PR, gates all merges
2. **Deploy** (`deploy.yml`) — fires only after CI passes, never directly on push

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

### 2. Use `npm install`, not `npm ci` in CI

`npm ci` breaks on cross-platform optional dependencies (e.g. native bindings differ between macOS arm64 and Linux x64). Use `npm install` in the composite setup-node action.

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

> `semgrep` starts as non-blocking. Flip to blocking after the team triages the first run's findings.

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
      run: npm install
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
          # Add dummy values for any env vars required at build time
          MONGODB_URI: mongodb://localhost:27017/dummy
          AUTH_SECRET: dummy-secret-for-build-only

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

```typescript
import type { KnipConfig } from "knip"

const config: KnipConfig = {
  entry: [
    "src/app/**/{page,layout,route,loading,error,not-found}.tsx",
    "src/app/api/**/*.ts",
    "next.config.{ts,js,mjs}",
    "scripts/*.ts",
  ],
  project: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
  ignore: ["src/components/ui/**"],
  ignoreDependencies: [
    "@playwright/test",
    "@testing-library/react",
    "@testing-library/user-event",
  ],
}

export default config
```

---

## `scripts/validate-env.ts`

```typescript
import { config } from "dotenv"
import { z } from "zod"

// vercel pull writes to this path; fall back to .env.local for local dev
config({ path: ".vercel/.env.production.local" })
config({ path: ".env.local" })

const envSchema = z.object({
  // Fill in the project's required env vars:
  // MONGODB_URI: z.string().min(1),
  // AUTH_SECRET: z.string().min(1),
})

const result = envSchema.safeParse(process.env)

if (!result.success) {
  console.error("❌ Environment variable validation failed:\n")
  for (const [field, issues] of Object.entries(result.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${issues?.join(", ")}`)
  }
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

## Dev dependencies to install

```bash
npm install -D knip vitest @vitest/coverage-v8 jsdom @testing-library/jest-dom @playwright/test dotenv
```

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
| `VERCEL_ALIAS_DEV` | Base URL for E2E on PRs |

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
2. **Check existing files** — never overwrite; print `⚠ skipped (already exists): <path>` for each conflict
3. **Copy workflow files** into `.github/workflows/` and `.github/actions/setup-node/`
4. **Copy test configs** — `vitest.config.ts`, `playwright.config.ts`, `knip.config.ts`, `src/test/setup.ts`
5. **Copy scripts** — `scripts/validate-env.ts` (user must fill in their env vars)
6. **Merge `package.json` scripts** — additive only, never remove existing scripts
7. **Install dev dependencies** — only those not already present
8. **Print next steps** — GitHub Secrets list, `VERCEL_ALIAS_DEV` variable, commit and push instructions
