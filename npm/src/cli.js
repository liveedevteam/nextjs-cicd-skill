#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { fileURLToPath } from "url"
import { dirname } from "path"

const __dir = dirname(fileURLToPath(import.meta.url))

const SKILL_NAME = "nextjs-cicd"
const TARGET_DIR = join(homedir(), ".claude", "skills", SKILL_NAME)
const TARGET_FILE = join(TARGET_DIR, "SKILL.md")
const SOURCE_FILE = join(__dir, "SKILL.md")

const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

console.log()
console.log(bold("  nextjs-cicd — Claude Code Skill Installer"))
console.log(dim("  https://liveedevteam.github.io/nextjs-cicd-skill/"))
console.log()

if (existsSync(TARGET_FILE)) {
  console.log(yellow(`  ⚠ Skipped — skill already exists: ${TARGET_FILE}`))
  console.log(dim("    Delete it first to reinstall."))
  console.log()
  process.exit(0)
}

mkdirSync(TARGET_DIR, { recursive: true })

const skill = readFileSync(SOURCE_FILE, "utf8")
writeFileSync(TARGET_FILE, skill, "utf8")

console.log(green(`  ✔ Installed: ${TARGET_FILE}`))
console.log()
console.log(bold("  Usage"))
console.log(dim("  In any Next.js project conversation, type:"))
console.log()
console.log("    /nextjs-cicd")
console.log()
console.log(dim("  The skill activates automatically when you ask Claude to:"))
console.log(dim("  • Set up CI/CD for a Next.js project"))
console.log(dim("  • Fix a failing CI job"))
console.log(dim("  • Debug deploy timing issues"))
console.log(dim("  • Add Playwright, Vitest, or knip"))
console.log()
