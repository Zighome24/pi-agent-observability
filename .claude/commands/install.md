---
description: Install pi-agent-observability — Bun + SQLite obs server, Pi observability extension, Steelman product-agent demo (Vue/Vite). Checks prerequisites, installs deps across four packages, verifies Pi auth, leaves a runnable system without starting any servers.
---

# Install pi-agent-observability

## Purpose

Walk a fresh clone of `pi-agent-observability` from "just got pulled down" to "ready to run `just all`". This is an interactive, agentic process — ask the user when choices are needed, install what can be installed automatically, never start a long-running server.

## Variables

PACKAGES: `extension/`, `apps/observability/`, `apps/steelman/server/`, `apps/steelman/web/` — the four `bun install` targets
PORTS: `43190` obs · `45210` Steelman API · `51730` Steelman web
PI_AUTH_FILE: `~/.pi/agent/auth.json`
STEELMAN_MODEL: `gemini-3.5-flash` on provider `google` — the product agent's default, set via `STEELMAN_AGENT_MODEL` / `STEELMAN_AGENT_MODEL_PROVIDER`; needs `GEMINI_API_KEY` or `pi /login`
ENV_SAMPLE: `.env.sample` — copy to `.env` to override any default

## Codebase Structure

```txt
.
├── justfile                          # task runner surface — start here
├── shared/types.ts                   # canonical ObsEvent wire format
├── extension/                        # Pi observability extension (Bun TS)
├── apps/
│   ├── observability/                # Bun + SQLite obs server + static UI
│   └── steelman/
│       ├── extension/                # Steelman product extension (research + artifact tools)
│       ├── server/                   # Steelman Bun backend (Pi RPC manager)
│       └── web/                      # Vite + Vue 3 + TypeScript frontend
└── scripts/                          # smoke + validation scripts
```

## Instructions

- Run every check via Bash — do not assume anything is installed.
- Show a status line immediately after each check (`✓ <thing>` on pass, `✗ <thing>` on fail).
- Critical prerequisites (`bun`, `pi`, `just`) gate — if any is missing, stop and guide the user.
- For auto-installable items (per-package `bun install`), install them without asking.
- For items requiring user input, ask the user with a sensible default.
- Do NOT read or display API key values — only confirm whether they're set.
- Do NOT start any servers, daemons, or watchers. Verification is read-only.
- Do NOT modify `~/.pi/agent/auth.json` or `~/.pi/agent/models.json` — those are user-scoped pi config.

## Workflow

### Step 1 — Check Prerequisites

Foundational, critical — gate hard on these.

```bash
command -v bun  >/dev/null 2>&1 && echo "✓ bun ($(bun --version))"   || echo "✗ bun MISSING"
command -v pi   >/dev/null 2>&1 && echo "✓ pi  ($(pi --version))"    || echo "✗ pi  MISSING"
command -v just >/dev/null 2>&1 && echo "✓ just ($(just --version))" || echo "✗ just MISSING"
```

If any are missing, stop and guide the user:

- **bun ≥ 1.1** — install via `curl -fsSL https://bun.sh/install | bash` or homebrew `brew install oven-sh/bun/bun`. Docs: <https://bun.sh>.
- **pi** — the Pi coding agent CLI from earendil-works. Install via `npm i -g @earendil-works/pi-coding-agent` or follow <https://github.com/earendil-works/pi-mono>.
- **just** — task runner. Install via `brew install just` (macOS), `cargo install just`, or see <https://just.systems>.

Then check the soft-but-useful tooling (do not gate):

```bash
command -v sqlite3 >/dev/null 2>&1 && echo "✓ sqlite3 (for just backup)" || echo "⚠ sqlite3 missing — just backup will fall back to file copy"
command -v lsof    >/dev/null 2>&1 && echo "✓ lsof"                       || echo "⚠ lsof missing — port clearing in justfile may not work"
command -v curl    >/dev/null 2>&1 && echo "✓ curl"                       || echo "⚠ curl missing — just all health probe will not work"
```

`sqlite3` is preinstalled on macOS. `lsof` is preinstalled on macOS/Linux. `curl` is preinstalled almost everywhere.

### Step 2 — Verify Pi Authentication

The Pi agent needs to be authenticated with at least one provider before any observed run will produce useful events. The default model is Google `gemini-3.5-flash` (set by Steelman via `STEELMAN_AGENT_MODEL` / `STEELMAN_AGENT_MODEL_PROVIDER`) — so `GEMINI_API_KEY` (or `pi /login` with Google) is what it needs out of the box.

```bash
test -f ~/.pi/agent/auth.json && echo "✓ ~/.pi/agent/auth.json exists" || echo "⚠ no pi auth file — run \`pi /login\` to set up a provider before running an observed agent"
pi --list-models 2>/dev/null | head -3 && echo "✓ pi can list models" || echo "⚠ \`pi --list-models\` failed — auth or PATH issue"
```

If unauthenticated, instruct: run `pi` interactively, then `/login` and follow the provider flow. Do NOT modify `auth.json` from this command.

### Step 3 — Check Environment

This project ships with safe defaults — no env vars are strictly required for local dev.

```bash
test -f .env && echo "✓ .env present" || echo "⚠ no .env — copy .env.sample → .env to override defaults (OBS_AUTH_TOKEN falls back to \"devtoken\")"
```

Every env var is optional and documented with its default in `.env.sample` — copy it to `.env` and edit only what you need. The most commonly touched: `OBS_AUTH_TOKEN` (shared token, default `devtoken`), `STEELMAN_AGENT_MODEL` / `STEELMAN_AGENT_MODEL_PROVIDER` (default `gemini-3.5-flash` / `google`), and `FIRECRAWL_BIN` (used by `steelman_research`; falls back to a dependency-light DuckDuckGo search when missing).

### Step 4 — Install Dependencies

Four packages, each independent. Install each one only if its `node_modules` is missing.

```bash
for pkg in extension apps/observability apps/steelman/server apps/steelman/web; do
  if [ -d "$pkg/node_modules" ]; then
    echo "✓ $pkg deps already installed"
  else
    echo "→ installing deps in $pkg"
    (cd "$pkg" && bun install)
  fi
done
```

The `extension/` and `apps/steelman/server/` packages have zero runtime deps — `bun install` just resolves dev deps and creates `node_modules` so editor tooling works. `server/` pulls `@types/bun`. `apps/steelman/web/` pulls Vue 3, Vite, marked, and TypeScript tooling.

### Step 5 — Prepare Runtime Directory

The per-file "does this source file exist" checks are redundant with Step 6 — parsing the justfile, building the obs server, and typechecking the web app all fail loudly if anything critical is missing or corrupt. The one thing worth doing here is a quick "am I in the repo root?" guard plus pre-creating the gitignored SQLite directory so the first boot has no surprise:

```bash
test -f justfile || echo "✗ justfile missing — are you in the repo root?"
mkdir -p db && echo "✓ db/ ready" || echo "✗ could not create db/"
```

### Step 6 — Verify Readiness

These confirm the system can boot without actually booting it.

```bash
just --list >/dev/null 2>&1 && echo "✓ justfile parses" || echo "✗ justfile fails to parse — open it for the error"
(cd apps/observability && bun build server.ts --target=bun --outfile=/dev/null >/dev/null 2>&1) && echo "✓ obs server typechecks" || echo "⚠ obs server build check failed — non-fatal but worth investigating"
(cd apps/steelman/web && bunx vue-tsc --noEmit 2>/dev/null) && echo "✓ Steelman web typechecks" || echo "⚠ Steelman web typecheck failed — non-fatal, will surface on \`bun run build\`"
```

Confirm the default ports are free (the justfile clears them anyway, but it's nice to know):

```bash
for port in 43190 45210 51730; do
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "⚠ port $port already in use — \`just all\` will clear it before boot"
  else
    echo "✓ port $port free"
  fi
done
```

### Step 7 — Report

Print a final summary table with one row per check from steps 1–6, columns: `Check`, `Status` (`✓` / `✗` / `⚠`), `Notes`. Bold the `Status` column.

Then a count: `READY: N/M checks passed` (M = total checks; N = passing `✓` only — warnings count as their own bucket).

Then the next steps, each as a runnable command with an inline comment:

```bash
just all                               # boot obs server + Steelman backend + Steelman web
open "http://127.0.0.1:43190/?token=devtoken"  # open the observability UI
just agent                             # interactive observed Pi agent — watch its events stream live
```

If any `✗` (fail) row appeared in steps 1–6, do NOT print the "next steps" block — instead print a short remediation list pointing at the specific failures.
