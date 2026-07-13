# Puddle Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase 0 (monorepo scaffold with CI and an embedded web placeholder) and Phase 1 (the complete daemon core: CRUD, local security, permissions gate, claude-code adapter, worktree manager, PTY/WS streaming, append-only logs, reconcile pass) per `SPEC.md` §14.

**Architecture:** A pnpm monorepo (`shared`/`daemon`/`web`/`cli`). The daemon is a composition-rooted Hono app: every subsystem (stores, worktree manager, PTY manager, session service, WS hub) is a small class receiving its dependencies via constructor, assembled in `createDaemon()`. SQLite is the source of truth; PTYs are ephemeral attachments; all API shapes are zod schemas in `packages/shared`. Tests run against real temp git repos, real SQLite files, and real PTYs (spawning `bash`, never a real agent), with `PUDDLE_HOME` pointing at a temp dir.

**Tech Stack:** Node 22 (ESM, `crypto.randomUUID`, global `WebSocket` for tests), TypeScript ~5.9 (pinned <6.1 for typescript-eslint compat), pnpm 11 workspaces + corepack, Hono 4 + `@hono/node-server` 2 (WebSocket support is **built in** via its `upgradeWebSocket` + a `ws` `WebSocketServer({ noServer: true })` — `@hono/node-ws` is deprecated, do not use it), `better-sqlite3` 12, `node-pty` 1.1 (prebuilds for darwin only — Linux hosts need python3/make/g++; note for Phase 6 tarballs), zod 4, vitest 4 (`projects` in root config; `vitest.workspace.*` was removed in v4), eslint 10 flat config + prettier, React 19 + Vite 8 (placeholder only in this plan). All versions verified against the npm registry on 2026-07-13.

## Global Constraints

Copied from `SPEC.md` / `CLAUDE.md` — every task's requirements implicitly include these:

- **British English everywhere**: comments, docs, commit bodies, UI copy, and identifiers you choose (`colour`, `initialise`, `behaviour`, `serialise`, `licence` as noun). Never rename third-party API surface (CSS `color`, library method names, external config keys).
- TypeScript strict; no `any` without a comment justifying it.
- Every REST/WS shape is a zod schema in `packages/shared`; the daemon validates input, consumers import inferred types. Never define an API shape locally.
- Agent-specific behaviour lives ONLY in `packages/daemon/src/agents/<id>.ts`. Core session logic stays agent-agnostic. Record the CLI version you verified flags against in a comment in the adapter (**claude-code flags below were verified against Claude Code 2.1.207 on 2026-07-13**).
- SQLite schema changes require a migration in `packages/daemon/src/db/migrations/`.
- Public MIT repo: no company-, team-, or person-specific names anywhere; generic placeholders (`alice`, `user@devbox`, `my-repo`). No code copied from AGPL projects.
- Terminology: a "session" is a *puddle* session (`sessions.id`); an agent's own conversation id is the "agent session ref" (`sessions.agent_session_ref`). Never conflate them.
- Daemon binds `127.0.0.1:7433` by default. All timestamps ISO 8601 UTC. Git ops per repo are serialised through a per-repo mutex.
- Permission prompts ON by default: effective skip flag for ANY spawn-like action is `requested ∧ profile gate ∧ account opt-in`, enforced server-side (create → 400; resume → silent downgrade with a note in the terminal).
- Puddle NEVER reads agent config dirs it did not create; every account gets a fresh dir under `~/.puddle/profiles/<profile>/accounts/<agent_type>/<label>/`.
- Files stay small and single-responsibility (~300-line seam rule). Prefer composition-root dependency injection over singletons/imports-with-side-effects.
- `CHANGELOG.md` `## [Unreleased]` updated in the same commit as every user-visible change (imperative mood, Keep-a-Changelog subsections).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Verified agent facts (do not re-derive)

Checked against installed **Claude Code 2.1.207** (2026-07-13):

- `--session-id <uuid>` — accepted; "must be a valid UUID" → puddle reuses the puddle session uuid as the claude session id (`presetSessionId: true`; `agent_session_ref = sessions.id`).
- `-r, --resume [value]` — resume by session ID; accepts a positional prompt after it (used for the interrupted-resume note).
- `--dangerously-skip-permissions` — present.
- `claude auth login` / `claude auth status` — present (login flow).
- `CLAUDE_CONFIG_DIR` — verified empirically: pointing it at a fresh dir makes claude create `.claude.json` and all state there.
- Conversations stored as JSONL under `<config_dir>/projects/<escaped-cwd>/<uuid>.jsonl` (verify visually during the Phase 1 acceptance run; nothing in Phase 1 parses it).

## File structure (end state of this plan)

```
package.json  pnpm-workspace.yaml  pnpm-lock.yaml  tsconfig.base.json
eslint.config.js  .prettierrc.json  .prettierignore  .gitignore  .npmrc
.github/workflows/ci.yml
vitest.config.ts                      # root: projects = packages/*
docs/acceptance/phase-1.md            # manual acceptance script (curl + wscat + real claude)
packages/
├── shared/         # zod schemas — single source of truth for API shapes
│   ├── package.json  tsconfig.json
│   └── src/
│       ├── index.ts                  # re-exports everything
│       ├── api/common.ts             # error envelope, id/timestamp primitives
│       ├── api/profiles.ts  api/accounts.ts  api/repos.ts  api/projects.ts
│       ├── api/sessions.ts  api/config.ts  api/version.ts
│       └── ws/messages.ts            # client→server and server→client unions
├── daemon/
│   ├── package.json  tsconfig.json
│   ├── scripts/copy-web-assets.mjs   # web dist → daemon dist/public at build
│   └── src/
│       ├── index.ts                  # bin entry: createDaemon().start()
│       ├── daemon.ts                 # composition root: createDaemon(opts)
│       ├── paths.ts                  # ~/.puddle layout (PUDDLE_HOME override)
│       ├── config.ts                 # config.json load/save with defaults
│       ├── db/db.ts                  # open + pragmas + migration runner
│       ├── db/migrations/001-initial.sql
│       ├── db/stores/profiles.ts  accounts.ts  repos.ts  projects.ts
│       ├── db/stores/sessions.ts  events.ts
│       ├── security/token.ts         # ensureToken (0600)
│       ├── security/middleware.ts    # Host/Origin validation + bearer auth
│       ├── agents/adapter.ts         # AgentAdapter interface + LaunchOpts
│       ├── agents/claude-code.ts     # the one Phase 1 adapter
│       ├── agents/registry.ts
│       ├── git/exec.ts               # execFile git wrapper
│       ├── git/mutex.ts              # KeyedMutex (per-repo serialisation)
│       ├── worktrees/manager.ts      # create/remove/isClean, fetch policy, branch naming
│       ├── logs/log-store.ts         # append-only per-term logs + tail replay
│       ├── pty/pty-manager.ts        # node-pty spawn/write/resize/kill, tee to logs
│       ├── pty/status-detector.ts    # ANSI strip + statusPatterns + quiet debounce
│       ├── pty/ansi.ts               # stripAnsi()
│       ├── sessions/service.ts       # lifecycle orchestration + state machine
│       ├── sessions/onboarding.ts    # preamble builder + marker-file sync watcher
│       ├── sessions/reconcile.ts     # boot reconcile pass
│       ├── http/app.ts               # buildApp(deps): middleware + routes + static
│       ├── http/static.ts            # tiny absolute-path static middleware
│       ├── http/errors.ts            # ApiError + error handler
│       └── http/routes/profiles.ts  accounts.ts  repos.ts  projects.ts
│           sessions.ts  config.ts  version.ts
│       └── ws/handler.ts             # WS auth + message dispatch + hub
│   └── test/                         # vitest; helpers in test/helpers/
├── web/            # placeholder SPA (real UI is Phase 2)
│   ├── package.json  tsconfig.json  vite.config.ts  index.html
│   └── src/main.tsx  src/App.tsx
└── cli/            # placeholder bin (real CLI is Phase 6)
    ├── package.json  tsconfig.json
    └── src/index.ts
```

**Out of scope for this plan** (later phases, per SPEC §14): all real UI (Phase 2), file/diff/history/ports/proxy endpoints (Phases 3–5), the real CLI including bootstrap/tunnel/systemd install (Phase 6), codex/opencode adapters + migrate/handoff endpoints (Phase 7), prompt-bank endpoints and log rotation (Phase 8). The `project_states` GET/PUT endpoints land with Phase 2 (their table ships now in the schema). The `prompts` and `project_states` tables are created in migration 001 because the schema is settled in SPEC §3 — only their endpoints are deferred.

---

# Phase 0 — scaffold

### Task 1: Repo root — workspace, toolchain, lint

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.gitignore`, `tsconfig.base.json`, `.prettierrc.json`, `.prettierignore`, `eslint.config.js`

**Interfaces:**
- Produces: `tsconfig.base.json` every package extends; root scripts `build`, `test`, `lint`, `typecheck`, `dev` that later tasks and CI call.

- [ ] **Step 1: Enable pnpm via corepack and pin it**

```bash
corepack enable pnpm
corepack use pnpm@latest   # writes the pinned "packageManager" field into package.json (creates it if absent)
pnpm --version             # expect 10.x
```

- [ ] **Step 2: Write root config files**

`package.json` (merge with the `packageManager` field corepack wrote — keep corepack's exact pinned version):

```json
{
  "name": "puddle-monorepo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm --filter @puddle/shared build && pnpm --filter @puddle/web build && pnpm --filter @puddle/daemon build && pnpm --filter puddle build",
    "typecheck": "tsc -b packages/shared packages/daemon packages/cli && pnpm --filter @puddle/web typecheck",
    "test": "vitest run",
    "lint": "eslint . && prettier --check .",
    "format": "prettier --write .",
    "dev": "pnpm --parallel --filter @puddle/daemon --filter @puddle/web dev"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
```

`.npmrc`:

```
engine-strict=true
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.DS_Store
coverage/
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true
  }
}
```

`.prettierrc.json`:

```json
{ "singleQuote": true, "printWidth": 100 }
```

`.prettierignore`:

```
dist/
pnpm-lock.yaml
CHANGELOG.md
docs/
```

`eslint.config.js` (eslint 10 is flat-config only; `defineConfig` from `eslint/config` is the current helper):

```js
// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/**'] },
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
```

- [ ] **Step 3: Install root dev dependencies**

typescript is pinned `~5.9.3`: npm `latest` typescript is the 7.x native-port line, and typescript-eslint 8.x accepts only `>=4.8.4 <6.1`.

```bash
pnpm add -Dw typescript@~5.9.3 eslint @eslint/js typescript-eslint eslint-config-prettier prettier vitest
```

- [ ] **Step 4: Verify lint/format pass on the empty repo**

```bash
pnpm lint
```

Expected: exits 0 (nothing to lint yet beyond configs).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm workspace, TypeScript, eslint and prettier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: `packages/shared` — schema package skeleton

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/api/common.ts`
- Test: `packages/shared/test/common.test.ts`

**Interfaces:**
- Produces: package `@puddle/shared` importable by daemon/web/cli; `errorResponseSchema`, `apiError(code, message)` helper type `ErrorResponse`. Full API schemas arrive in Task 10 — this task proves the package + vitest pipeline.

- [ ] **Step 1: Write package files**

`packages/shared/package.json`:

```json
{
  "name": "@puddle/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -b", "typecheck": "tsc -b --noEmit" },
  "dependencies": { "zod": "^4.0.0" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/shared/src/api/common.ts`:

```ts
import { z } from 'zod';

/** Uniform error envelope for every non-2xx API response. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const isoTimestamp = z.iso.datetime(); // zod v4 form; z.string().datetime() is the deprecated v3 spelling

/** SQLite integer primary keys. */
export const rowId = z.number().int().positive();

/** Puddle session ids are uuids (also reused as claude-code session ids). */
export const sessionId = z.uuid();
```

`packages/shared/src/index.ts`:

```ts
export * from './api/common.js';
```

- [ ] **Step 2: Install and write the failing test**

```bash
pnpm --filter @puddle/shared add zod
```

`packages/shared/test/common.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { errorResponseSchema } from '../src/index.js';

describe('errorResponseSchema', () => {
  it('accepts a well-formed error envelope', () => {
    const parsed = errorResponseSchema.parse({
      error: { code: 'not_found', message: 'no such profile' },
    });
    expect(parsed.error.code).toBe('not_found');
  });

  it('rejects an envelope missing the code', () => {
    expect(errorResponseSchema.safeParse({ error: { message: 'x' } }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Wire the root vitest config and run**

`vitest.config.ts` (repo root — vitest 4 `projects`; each package may add its own `vitest.config.ts` for aliases/timeouts):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
```

```bash
pnpm test
```

Expected: 2 passing tests in `shared`.

- [ ] **Step 4: Build and typecheck**

```bash
pnpm --filter @puddle/shared build
```

Expected: `packages/shared/dist/index.js` + `.d.ts` exist.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shared): schema package skeleton with error envelope

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: `packages/web` — placeholder SPA that builds to static assets

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/index.html`, `packages/web/src/main.tsx`, `packages/web/src/App.tsx`

**Interfaces:**
- Produces: `pnpm --filter @puddle/web build` → `packages/web/dist/` static assets (index.html + hashed js). Task 4's daemon build copies this directory. Real UI replaces `App.tsx` in Phase 2.

- [ ] **Step 1: Write package files**

`packages/web/package.json`:

```json
{
  "name": "@puddle/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": { "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", "@vitejs/plugin-react": "^6.0.0", "vite": "^8.0.0" }
}
```

`packages/web/tsconfig.json` (web is bundler-resolved, not NodeNext — do not extend the base `composite`):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "lib": ["ES2023", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

`packages/web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:7433', '/ws': { target: 'ws://127.0.0.1:7433', ws: true } },
  },
});
```

`packages/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>puddle</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/web/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
```

`packages/web/src/App.tsx`:

```tsx
export function App() {
  return (
    <main style={{ fontFamily: 'monospace', padding: '2rem' }}>
      <h1>puddle</h1>
      <p>The web UI arrives in Phase 2. The daemon is serving this placeholder.</p>
    </main>
  );
}
```

- [ ] **Step 2: Install and build**

```bash
pnpm install
pnpm --filter @puddle/web build
```

Expected: `packages/web/dist/index.html` and `packages/web/dist/assets/*.js` exist.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @puddle/web typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(web): placeholder SPA built to static assets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: `packages/daemon` skeleton — Hono app, static embedding, /api/version

**Files:**
- Create: `packages/daemon/package.json`, `packages/daemon/tsconfig.json`, `packages/daemon/scripts/copy-web-assets.mjs`, `packages/daemon/src/http/static.ts`, `packages/daemon/src/http/routes/version.ts`, `packages/daemon/src/http/app.ts` (minimal — grows in Phase 1), `packages/daemon/src/index.ts` (minimal)
- Create: `packages/shared/src/api/version.ts`, modify `packages/shared/src/index.ts`
- Test: `packages/daemon/test/version.test.ts`, `packages/daemon/test/static.test.ts`

**Interfaces:**
- Produces: `buildApp(deps: AppDeps): Hono` in `http/app.ts` — Phase 1 tasks extend `AppDeps` and mount routes here. `staticAssets(rootDir: string)` middleware serving files from an **absolute** directory with index.html fallback. `GET /api/version → { version: string }` validated by `versionResponseSchema` from shared. Daemon build = `tsc -b` + copy `../web/dist` → `dist/public`.

Design note: `serveStatic` from `@hono/node-server` resolves `root` relative to `process.cwd()`, which is wrong for a daemon launched by systemd from an arbitrary cwd. We write a ~40-line absolute-path static middleware instead — no extra dependency, testable.

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { versionResponseSchema } from '@puddle/shared';
import { buildApp } from '../src/http/app.js';

describe('GET /api/version', () => {
  it('returns the daemon version', async () => {
    const app = buildApp({ version: '0.0.1', assetsDir: null });
    const res = await app.request('/api/version');
    expect(res.status).toBe(200);
    const body = versionResponseSchema.parse(await res.json());
    expect(body.version).toBe('0.0.1');
  });
});
```

`packages/daemon/test/static.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';

function withAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-assets-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>puddle</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("hi")');
  return dir;
}

describe('static asset serving', () => {
  it('serves index.html at /', async () => {
    const app = buildApp({ version: '0.0.1', assetsDir: withAssets() });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('puddle');
  });

  it('serves hashed assets with the right mime type', async () => {
    const app = buildApp({ version: '0.0.1', assetsDir: withAssets() });
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('falls back to index.html for SPA routes', async () => {
    const app = buildApp({ version: '0.0.1', assetsDir: withAssets() });
    const res = await app.request('/project/42');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('puddle');
  });

  it('refuses path traversal', async () => {
    const app = buildApp({ version: '0.0.1', assetsDir: withAssets() });
    const res = await app.request('/assets/../../etc/passwd');
    expect([200, 404]).toContain(res.status); // must not 500 and must not leak — fallback serves index.html
    expect(await res.text()).not.toContain('root:');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run --project daemon
```

Expected: FAIL — cannot resolve `../src/http/app.js`.

- [ ] **Step 3: Write the package and implementation**

`packages/daemon/package.json`:

```json
{
  "name": "@puddle/daemon",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "puddled": "./dist/index.js" },
  "scripts": {
    "build": "tsc -b && node scripts/copy-web-assets.mjs",
    "dev": "tsc -b --watch",
    "typecheck": "tsc -b --noEmit"
  },
  "dependencies": {
    "@hono/node-server": "^2.0.0",
    "@puddle/shared": "workspace:*",
    "better-sqlite3": "^12.0.0",
    "hono": "^4.12.0",
    "node-pty": "^1.1.0",
    "ws": "^8.21.0"
  },
  "devDependencies": { "@types/better-sqlite3": "^7.6.0", "@types/node": "^22.0.0", "@types/ws": "^8.18.0" }
}
```

`packages/daemon/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["node"] },
  "include": ["src"],
  "references": [{ "path": "../shared" }]
}
```

`packages/daemon/scripts/copy-web-assets.mjs`:

```js
// Embed the built web UI into the daemon package so one artefact serves both.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', '..', 'web', 'dist');
const target = join(here, '..', 'dist', 'public');

if (!existsSync(webDist)) {
  console.error('web assets not built — run `pnpm --filter @puddle/web build` first');
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(webDist, target, { recursive: true });
console.log(`embedded web assets → ${target}`);
```

`packages/daemon/src/http/static.ts`:

```ts
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { MiddlewareHandler } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function fileResponse(path: string): Response {
  const type = MIME[extname(path)] ?? 'application/octet-stream';
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new Response(stream, {
    headers: { 'content-type': type, 'content-length': String(statSync(path).size) },
  });
}

/**
 * Serve static files from an absolute directory with an index.html fallback
 * for SPA routes. Written in-house because @hono/node-server's serveStatic
 * resolves its root relative to process.cwd(), which is meaningless for a
 * daemon launched by systemd.
 */
export function staticAssets(rootDir: string): MiddlewareHandler {
  const root = resolve(rootDir);
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const requested = normalize(join(root, decodeURIComponent(new URL(c.req.url).pathname)));
    // Confinement: anything escaping the root falls through to the SPA index.
    const candidate =
      requested.startsWith(root + sep) || requested === root ? requested : root;
    if (existsSync(candidate) && statSync(candidate).isFile()) return fileResponse(candidate);
    const index = join(root, 'index.html');
    if (existsSync(index)) return fileResponse(index);
    return next();
  };
}
```

`packages/shared/src/api/version.ts`:

```ts
import { z } from 'zod';

export const versionResponseSchema = z.object({ version: z.string() });
export type VersionResponse = z.infer<typeof versionResponseSchema>;
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './api/version.js';
```

`packages/daemon/src/http/routes/version.ts`:

```ts
import { Hono } from 'hono';
import type { VersionResponse } from '@puddle/shared';

export function versionRoutes(version: string): Hono {
  return new Hono().get('/', (c) => c.json<VersionResponse>({ version }));
}
```

`packages/daemon/src/http/app.ts` (minimal — Phase 1 tasks grow `AppDeps`):

```ts
import { Hono } from 'hono';
import { versionRoutes } from './routes/version.js';
import { staticAssets } from './static.js';

export interface AppDeps {
  version: string;
  /** Absolute dir of embedded UI assets; null in tests that don't exercise static serving. */
  assetsDir: string | null;
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route('/api/version', versionRoutes(deps.version));
  if (deps.assetsDir) app.use('*', staticAssets(deps.assetsDir));
  return app;
}
```

`packages/daemon/src/index.ts` (minimal; replaced by the composition root in Task 24):

```ts
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './http/app.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  version: string;
};
const app = buildApp({ version: pkg.version, assetsDir: join(here, 'public') });
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 7433 }, (info) => {
  console.log(`puddled listening on http://127.0.0.1:${info.port}`);
});
```

Install:

```bash
pnpm install
pnpm --filter @puddle/shared build   # daemon tests import built types via project refs
```

Also add a vitest alias so daemon tests always see shared **source** (no stale dist): create `packages/daemon/vitest.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@puddle/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: { testTimeout: 20000 },
});
```

(The root `vitest.config.ts` already globs `packages/*`, so vitest picks this package config up automatically.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run
```

Expected: shared + daemon tests all PASS.

- [ ] **Step 5: Verify the Phase 0 acceptance test end-to-end**

```bash
pnpm build
node packages/daemon/dist/index.js &
sleep 1
curl -s http://127.0.0.1:7433/api/version   # → {"version":"0.0.1"}
curl -s http://127.0.0.1:7433/ | grep -o '<title>puddle</title>'
kill %1
```

Expected: version JSON and the embedded index.html title.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(daemon): Hono skeleton serving /api/version and embedded web assets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: `packages/cli` placeholder

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/index.ts`

**Interfaces:**
- Produces: npm package `puddle` with a `puddle` bin that prints version and a Phase 6 pointer. Real commands are Phase 6; this reserves the structure (`src/lib/` for importable logic later).

- [ ] **Step 1: Write package files**

`packages/cli/package.json`:

```json
{
  "name": "puddle",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "puddle": "./dist/index.js" },
  "scripts": { "build": "tsc -b", "typecheck": "tsc -b --noEmit" },
  "devDependencies": { "@types/node": "^22.0.0" }
}
```

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["node"] },
  "include": ["src"]
}
```

`packages/cli/src/index.ts`:

```ts
#!/usr/bin/env node
// The full CLI (start/connect/attach/status/logs/upgrade) lands in Phase 6.
console.log('puddle 0.0.1 — CLI commands arrive in Phase 6. Run the daemon directly: puddled');
```

- [ ] **Step 2: Build and run**

```bash
pnpm install && pnpm --filter puddle build && node packages/cli/dist/index.js
```

Expected: the placeholder line prints.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(cli): placeholder bin reserving package structure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 6: CI workflow + changelog

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: CI running install → lint → typecheck → test → build on push/PR. Phase 0 acceptance: `pnpm build` produces daemon with embedded UI assets; CI green.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4 # reads the pinned version from packageManager
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - name: assert web assets embedded in daemon
        run: test -f packages/daemon/dist/public/index.html
```

- [ ] **Step 2: Update the changelog**

`CHANGELOG.md` already carries the scaffold line under `### Added`; verify it reads:

```markdown
### Added
- Initial scaffold: monorepo (shared / daemon / web / cli), CI, SPEC.md, CLAUDE.md, changelog conventions.
```

- [ ] **Step 3: Run the full local equivalent of CI**

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build && test -f packages/daemon/dist/public/index.html && echo PHASE-0-AT-PASS
```

Expected: `PHASE-0-AT-PASS`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci: typecheck, test and build workflow with embedded-assets assertion

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Phase 1 — daemon core

Architecture rules for every Phase 1 task:

- **Composition-root DI**: no module reads globals or constructs its own dependencies; everything is a class/function taking deps, assembled in `daemon.ts` (Task 24). Tests construct subsystems directly with temp-dir deps.
- `PUDDLE_HOME` env var overrides `~/.puddle` (used by every test; also handy for running two daemons side by side).
- Stores throw `ApiError` (Task 8) for not-found/conflict; the Hono error handler renders the uniform envelope. HTTP-status-in-store is a deliberate, documented trade-off for this codebase's size.
- Every route parses input with the shared zod schema before touching a store; invalid input → 400 `invalid_request`.

### Task 7: Paths and daemon config

**Files:**
- Create: `packages/daemon/src/paths.ts`, `packages/daemon/src/config.ts`, `packages/shared/src/api/config.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/daemon/test/paths.test.ts`, `packages/daemon/test/config.test.ts`

**Interfaces:**
- Produces:
  - `resolvePaths(home?: string): PuddlePaths` — every path the daemon touches; `home` defaults to `process.env.PUDDLE_HOME ?? ~/.puddle`.
  - `ensureHome(paths: PuddlePaths): void` — creates `home` (0700), `worktrees/`, `logs/`, `profiles/`.
  - `loadConfig(paths: PuddlePaths): DaemonConfig`, `saveConfig(paths, patch: DaemonConfigPatch): DaemonConfig`.
  - Shared: `daemonConfigSchema`, `daemonConfigPatchSchema`, types `DaemonConfig`, `DaemonConfigPatch`.

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/paths.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';

describe('resolvePaths', () => {
  it('lays out every path under the given home', () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-home-'));
    const p = resolvePaths(home);
    expect(p.dbFile).toBe(join(home, 'puddle.db'));
    expect(p.tokenFile).toBe(join(home, 'token'));
    expect(p.configFile).toBe(join(home, 'config.json'));
    expect(p.accountConfigDir('alice', 'claude-code', 'personal')).toBe(
      join(home, 'profiles', 'alice', 'accounts', 'claude-code', 'personal'),
    );
    expect(p.sessionWorktreeDir(3, 'abc')).toBe(join(home, 'worktrees', '3', 'abc'));
    expect(p.sessionLogDir('abc')).toBe(join(home, 'logs', 'abc'));
  });

  it('honours PUDDLE_HOME when no explicit home is given', () => {
    process.env.PUDDLE_HOME = '/tmp/elsewhere';
    try {
      expect(resolvePaths().home).toBe('/tmp/elsewhere');
    } finally {
      delete process.env.PUDDLE_HOME;
    }
  });
});
```

`packages/daemon/test/config.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';
import { ensureHome, resolvePaths } from '../src/paths.js';

function freshPaths() {
  const p = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-home-')));
  ensureHome(p);
  return p;
}

describe('daemon config', () => {
  it('returns defaults when config.json is absent and writes it', () => {
    const paths = freshPaths();
    const cfg = loadConfig(paths);
    expect(cfg).toEqual({
      port: 7433,
      autoResume: false,
      fetchIntervalMinutes: 15,
      logMaxBytes: 10 * 1024 * 1024,
      replayBytes: 256 * 1024,
    });
    expect(JSON.parse(readFileSync(paths.configFile, 'utf8')).port).toBe(7433);
  });

  it('merges patches and persists them', () => {
    const paths = freshPaths();
    loadConfig(paths);
    const updated = saveConfig(paths, { autoResume: true });
    expect(updated.autoResume).toBe(true);
    expect(loadConfig(paths).autoResume).toBe(true);
  });

  it('rejects an invalid patch', () => {
    const paths = freshPaths();
    loadConfig(paths);
    expect(() => saveConfig(paths, { port: -1 } as never)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run --project daemon
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/shared/src/api/config.ts`:

```ts
import { z } from 'zod';

/** Daemon-scope settings persisted in ~/.puddle/config.json. */
export const daemonConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(7433),
  autoResume: z.boolean().default(false),
  fetchIntervalMinutes: z.number().int().min(1).default(15),
  logMaxBytes: z
    .number()
    .int()
    .min(64 * 1024)
    .default(10 * 1024 * 1024),
  replayBytes: z
    .number()
    .int()
    .min(1024)
    .default(256 * 1024),
});
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

export const daemonConfigPatchSchema = daemonConfigSchema.partial();
export type DaemonConfigPatch = z.infer<typeof daemonConfigPatchSchema>;
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './api/config.js';
```

`packages/daemon/src/paths.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Every filesystem location the daemon touches, derived from one home dir. */
export interface PuddlePaths {
  home: string;
  dbFile: string;
  tokenFile: string;
  configFile: string;
  profilesDir: string;
  worktreesDir: string;
  logsDir: string;
  accountConfigDir(profileName: string, agentType: string, label: string): string;
  sessionWorktreeDir(repoId: number, sessionId: string): string;
  sessionLogDir(sessionId: string): string;
}

export function resolvePaths(
  home: string = process.env.PUDDLE_HOME ?? join(homedir(), '.puddle'),
): PuddlePaths {
  return {
    home,
    dbFile: join(home, 'puddle.db'),
    tokenFile: join(home, 'token'),
    configFile: join(home, 'config.json'),
    profilesDir: join(home, 'profiles'),
    worktreesDir: join(home, 'worktrees'),
    logsDir: join(home, 'logs'),
    accountConfigDir: (profileName, agentType, label) =>
      join(home, 'profiles', profileName, 'accounts', agentType, label),
    sessionWorktreeDir: (repoId, sessionId) => join(home, 'worktrees', String(repoId), sessionId),
    sessionLogDir: (sessionId) => join(home, 'logs', sessionId),
  };
}

export function ensureHome(paths: PuddlePaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.profilesDir, { recursive: true });
  mkdirSync(paths.worktreesDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
}
```

`packages/daemon/src/config.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import {
  daemonConfigPatchSchema,
  daemonConfigSchema,
  type DaemonConfig,
  type DaemonConfigPatch,
} from '@puddle/shared';
import type { PuddlePaths } from './paths.js';

function read(paths: PuddlePaths): DaemonConfig {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  } catch {
    // Absent or unreadable → defaults; loadConfig persists them below.
  }
  return daemonConfigSchema.parse(raw);
}

/** Load config.json, filling defaults; writes the file so users can discover the knobs. */
export function loadConfig(paths: PuddlePaths): DaemonConfig {
  const cfg = read(paths);
  writeFileSync(paths.configFile, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

export function saveConfig(paths: PuddlePaths, patch: DaemonConfigPatch): DaemonConfig {
  const merged = daemonConfigSchema.parse({ ...read(paths), ...daemonConfigPatchSchema.parse(patch) });
  writeFileSync(paths.configFile, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run --project daemon
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): puddle home layout and config.json handling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: Shared API schemas — entities, requests, WS messages

**Files:**
- Create: `packages/shared/src/api/profiles.ts`, `.../accounts.ts`, `.../repos.ts`, `.../projects.ts`, `.../sessions.ts`, `packages/shared/src/ws/messages.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/api.test.ts`

**Interfaces:**
- Consumes: `isoTimestamp`, `rowId`, `sessionId` from `api/common.ts` (Task 2).
- Produces (all exported from `@puddle/shared`; these exact names are used by every daemon task):
  - Entities: `profileSchema`/`Profile`, `profileSettingsSchema`/`ProfileSettings`, `accountSchema`/`Account`, `repoSchema`/`Repo`, `repoWithOrphansSchema`/`RepoWithOrphans`, `projectSchema`/`Project`, `projectDetailSchema`/`ProjectDetail`, `sessionSchema`/`Session`, `sessionStatusSchema`/`SessionStatus`.
  - Requests: `createProfileRequestSchema`, `patchProfileSettingsRequestSchema`, `createAccountRequestSchema`, `loginResponseSchema`/`LoginResponse`, `createRepoRequestSchema`, `patchRepoRequestSchema`, `createProjectRequestSchema`, `archiveRequestSchema`, `createSessionRequestSchema`/`CreateSessionRequest`, `patchSessionRequestSchema`.
  - WS: `wsClientMessageSchema`/`WsClientMessage`, `WsServerMessage` (plain type — the daemon constructs these, nothing parses them).

- [ ] **Step 1: Write the failing test**

`packages/shared/test/api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  createSessionRequestSchema,
  profileSettingsSchema,
  sessionStatusSchema,
  wsClientMessageSchema,
} from '../src/index.js';

describe('shared API schemas', () => {
  it('profile settings default the permissions gate to off and keep unknown keys', () => {
    const s = profileSettingsSchema.parse({ theme: 'dark' });
    expect(s.allowSkipPermissions).toBe(false);
    expect((s as Record<string, unknown>).theme).toBe('dark');
  });

  it('session status is a closed enum', () => {
    expect(sessionStatusSchema.safeParse('running').success).toBe(true);
    expect(sessionStatusSchema.safeParse('paused').success).toBe(false);
  });

  it('create-session accepts optional prompt and skip flag', () => {
    const r = createSessionRequestSchema.parse({ project_id: 1, account_id: 2, prompt: 'go' });
    expect(r.skip_permissions).toBeUndefined();
  });

  it('ws client messages discriminate on t', () => {
    expect(
      wsClientMessageSchema.parse({ t: 'attach', session: 'x', term: 'agent', cols: 80, rows: 24 }).t,
    ).toBe('attach');
    expect(wsClientMessageSchema.safeParse({ t: 'attach', term: 'agent' }).success).toBe(false);
    expect(wsClientMessageSchema.safeParse({ t: 'stdin', session: 'x', term: 'nope', data: 'y' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run --project shared
```

Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

`packages/shared/src/api/profiles.ts`:

```ts
import { z } from 'zod';
import { isoTimestamp, rowId } from './common.js';

/** Filesystem-safe: profile names become directory names under ~/.puddle/profiles/. */
export const fsSafeName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dot, underscore and hyphen only');

export const profileSchema = z.object({
  id: rowId,
  name: fsSafeName,
  branch_prefix: z.string(),
  created_at: isoTimestamp,
});
export type Profile = z.infer<typeof profileSchema>;

export const createProfileRequestSchema = z.object({
  name: fsSafeName,
  branch_prefix: z.string().max(64).optional(),
});

/**
 * Profile-scope settings JSON. Loose: later phases add keys (default account,
 * notifications, …) without a daemon migration. Phase 1 validates only the gate.
 */
export const profileSettingsSchema = z.looseObject({
  allowSkipPermissions: z.boolean().default(false),
});
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;

export const patchProfileSettingsRequestSchema = z.record(z.string(), z.unknown());
```

`packages/shared/src/api/accounts.ts`:

```ts
import { z } from 'zod';
import { isoTimestamp, rowId } from './common.js';
import { fsSafeName } from './profiles.js';

export const accountSchema = z.object({
  id: rowId,
  profile_id: rowId,
  agent_type: z.string(),
  label: z.string(),
  config_dir: z.string(),
  skip_permissions_default: z.boolean(),
  logged_in: z.boolean(),
  created_at: isoTimestamp,
});
export type Account = z.infer<typeof accountSchema>;

export const createAccountRequestSchema = z.object({
  profile_id: rowId,
  agent_type: z.string().min(1),
  label: fsSafeName,
  skip_permissions_default: z.boolean().optional(),
});

/** Returned by POST /api/accounts/:id/login — attach to this PTY over the WS. */
export const loginResponseSchema = z.object({ stream: z.string(), term: z.string() });
export type LoginResponse = z.infer<typeof loginResponseSchema>;
```

`packages/shared/src/api/repos.ts`:

```ts
import { z } from 'zod';
import { rowId, isoTimestamp } from './common.js';

export const repoSchema = z.object({
  id: rowId,
  path: z.string(),
  default_base_branch: z.string(),
  onboarding_notes: z.string().nullable(),
  fetch_enabled: z.boolean(),
  last_fetched_at: isoTimestamp.nullable(),
});
export type Repo = z.infer<typeof repoSchema>;

/** GET /api/repos items: repo plus worktree dirs on disk that no session row claims. */
export const repoWithOrphansSchema = repoSchema.extend({
  orphan_worktrees: z.array(z.string()),
});
export type RepoWithOrphans = z.infer<typeof repoWithOrphansSchema>;

export const createRepoRequestSchema = z.object({
  path: z.string().min(1),
  default_base_branch: z.string().min(1).optional(),
  onboarding_notes: z.string().nullable().optional(),
  fetch_enabled: z.boolean().optional(),
});

export const patchRepoRequestSchema = z.object({
  default_base_branch: z.string().min(1).optional(),
  onboarding_notes: z.string().nullable().optional(),
  fetch_enabled: z.boolean().optional(),
});
```

`packages/shared/src/api/projects.ts`:

```ts
import { z } from 'zod';
import { isoTimestamp, rowId } from './common.js';
import { sessionSchema } from './sessions.js';

export const projectSchema = z.object({
  id: rowId,
  profile_id: rowId,
  repo_id: rowId,
  name: z.string(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectRequestSchema = z.object({
  profile_id: rowId,
  repo_id: rowId,
  name: z.string().min(1).max(100),
});

export const projectDetailSchema = z.object({
  project: projectSchema,
  sessions: z.array(sessionSchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

/** Shared by session archive, project archive and kill-then-archive flows. */
export const archiveRequestSchema = z.object({ force: z.boolean().default(false) });
```

`packages/shared/src/api/sessions.ts`:

```ts
import { z } from 'zod';
import { isoTimestamp, rowId, sessionId } from './common.js';

export const sessionStatusSchema = z.enum([
  'starting',
  'running',
  'waiting_input',
  'exited',
  'interrupted',
  'archived',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.object({
  id: sessionId,
  project_id: rowId,
  account_id: rowId,
  worktree_path: z.string(),
  base_branch: z.string(),
  branch: z.string(),
  agent_type: z.string(),
  agent_session_ref: z.string().nullable(),
  title: z.string().nullable(),
  status: sessionStatusSchema,
  skip_permissions: z.boolean(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  last_activity_at: isoTimestamp.nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

export const createSessionRequestSchema = z.object({
  project_id: rowId,
  account_id: rowId,
  base_branch: z.string().min(1).optional(),
  branch: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  prompt: z.string().optional(),
  skip_permissions: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const patchSessionRequestSchema = z.object({ title: z.string().min(1).max(200) });
```

`packages/shared/src/ws/messages.ts`:

```ts
import { z } from 'zod';
import { sessionStatusSchema } from '../api/sessions.js';

/** Terminal ids within a stream: the agent PTY or numbered shells. */
export const termId = z.string().regex(/^(agent|shell-[0-9]+)$/);

const dims = {
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
};

/**
 * `session` addresses a PTY stream: a puddle session uuid, or `login-<accountId>`
 * for account-login PTYs (which attach "like a session", SPEC §6).
 */
export const wsClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string() }),
  z.object({ t: z.literal('attach'), session: z.string(), term: termId, ...dims }),
  z.object({ t: z.literal('stdin'), session: z.string(), term: termId, data: z.string() }),
  z.object({ t: z.literal('resize'), session: z.string(), term: termId, ...dims }),
  z.object({ t: z.literal('detach'), session: z.string(), term: termId }),
  z.object({ t: z.literal('spawn-shell'), session: z.string() }),
  z.object({ t: z.literal('subscribe-status') }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

export type WsServerMessage =
  | { t: 'shell-spawned'; session: string; term: string }
  | { t: 'replay'; session: string; term: string; data: string }
  | { t: 'output'; session: string; term: string; data: string }
  | {
      t: 'status';
      session: string;
      status: z.infer<typeof sessionStatusSchema>;
      last_activity_at: string | null;
    }
  | { t: 'exit'; session: string; term: string; code: number }
  | { t: 'error'; message: string };
```

Replace `packages/shared/src/index.ts` with:

```ts
export * from './api/common.js';
export * from './api/version.js';
export * from './api/config.js';
export * from './api/profiles.js';
export * from './api/accounts.js';
export * from './api/repos.js';
export * from './api/projects.js';
export * from './api/sessions.js';
export * from './ws/messages.js';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run --project shared && pnpm --filter @puddle/shared build
```

Expected: PASS and clean build.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shared): entity, request and WS message schemas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 9: SQLite — migrations, error type, stores

**Files:**
- Create: `packages/daemon/src/http/errors.ts`, `packages/daemon/src/db/db.ts`, `packages/daemon/src/db/migrations/index.ts`, `packages/daemon/src/db/migrations/001-initial.ts`, `packages/daemon/src/db/stores/profiles.ts`, `.../accounts.ts`, `.../repos.ts`, `.../projects.ts`, `.../sessions.ts`, `.../events.ts`
- Test: `packages/daemon/test/db.test.ts`, `packages/daemon/test/stores.test.ts`

**Interfaces:**
- Consumes: entity types and `profileSettingsSchema` from `@puddle/shared` (Task 8).
- Produces:
  - `class ApiError extends Error { constructor(status: number, code: string, message: string) }`.
  - `openDatabase(file: string): Database.Database` — pragmas (`journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`) + runs all pending migrations tracked via `PRAGMA user_version`.
  - Migrations are **TypeScript modules** (`{ version: number; name: string; sql: string }`) so `tsc` builds need no asset copying; `migrations/index.ts` exports the ordered `MIGRATIONS` array.
  - Stores (all constructor `new XStore(db)`):
    - `ProfileStore`: `create({ name, branch_prefix }): Profile`; `list(): Profile[]`; `get(id: number): Profile` (throws 404); `getByName(name): Profile | undefined`; `getSettings(id): ProfileSettings`; `patchSettings(id, patch: Record<string, unknown>): ProfileSettings`.
    - `AccountStore`: `create({ profile_id, agent_type, label, config_dir, skip_permissions_default }): Account`; `list(profileId?: number): Account[]`; `get(id): Account` (404); `setLoggedIn(id, loggedIn: boolean): void`.
    - `RepoStore`: `create({ path, default_base_branch, onboarding_notes, fetch_enabled }): Repo`; `list(): Repo[]`; `get(id): Repo` (404); `getByPath(path): Repo | undefined`; `patch(id, fields: Partial<Pick<Repo, 'default_base_branch' | 'onboarding_notes' | 'fetch_enabled'>>): Repo`; `setLastFetchedAt(id, iso: string): void`; `setOnboardingNotes(id, notes: string): void`.
    - `ProjectStore`: `create({ profile_id, repo_id, name }): Project`; `list(profileId?: number): Project[]`; `get(id): Project` (404); `touch(id): void` (bumps `updated_at`).
    - `SessionStore`: `create(row: NewSessionRow): Session`; `get(id: string): Session` (404); `list(filter: { project_id?: number; status?: SessionStatus }): Session[]`; `listActiveByRepo(repoId: number): Session[]` (non-archived); `listByStatus(statuses: SessionStatus[]): Session[]`; `setStatus(id, status: SessionStatus): Session` (also bumps `updated_at`); `setAgentSessionRef(id, ref: string): void`; `setTitle(id, title: string): void`; `setSkipPermissions(id, on: boolean): void`; `touchActivity(id, iso: string): void`. `NewSessionRow = { id: string; project_id: number; account_id: number; worktree_path: string; base_branch: string; branch: string; agent_type: string; title: string | null; skip_permissions: boolean }` (status starts `'starting'`).
    - `EventStore`: `record(sessionId: string, type: string, payload?: unknown): void`; `list(sessionId: string): Array<{ id: number; session_id: string; type: string; payload: unknown; created_at: string }>`.
  - All stores map SQLite integers ↔ API booleans and return the shared API shapes. Timestamps via `new Date().toISOString()`.

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/db.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/db.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';

function freshDb() {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'puddle-db-')), 'puddle.db'));
}

describe('openDatabase', () => {
  it('applies all migrations and records user_version', () => {
    const db = freshDb();
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['profiles', 'accounts', 'repos', 'projects', 'project_states', 'sessions', 'prompts', 'events']) {
      expect(tables).toContain(t);
    }
  });

  it('is idempotent across reopen', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-db-')), 'puddle.db');
    openDatabase(file).close();
    const db = openDatabase(file);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
  });

  it('enforces foreign keys', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(`INSERT INTO accounts (profile_id, agent_type, label, config_dir, created_at) VALUES (999, 'claude-code', 'x', '/tmp/x', '2026-01-01T00:00:00Z')`)
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});
```

`packages/daemon/test/stores.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/db.js';
import { AccountStore } from '../src/db/stores/accounts.js';
import { EventStore } from '../src/db/stores/events.js';
import { ProfileStore } from '../src/db/stores/profiles.js';
import { ProjectStore } from '../src/db/stores/projects.js';
import { RepoStore } from '../src/db/stores/repos.js';
import { SessionStore } from '../src/db/stores/sessions.js';
import { ApiError } from '../src/http/errors.js';

function stores() {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'puddle-db-')), 'puddle.db'));
  return {
    profiles: new ProfileStore(db),
    accounts: new AccountStore(db),
    repos: new RepoStore(db),
    projects: new ProjectStore(db),
    sessions: new SessionStore(db),
    events: new EventStore(db),
  };
}

function seedSession(s: ReturnType<typeof stores>) {
  const profile = s.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
  const account = s.accounts.create({
    profile_id: profile.id,
    agent_type: 'claude-code',
    label: 'personal',
    config_dir: '/tmp/cfg',
    skip_permissions_default: false,
  });
  const repo = s.repos.create({
    path: '/tmp/my-repo',
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: true,
  });
  const project = s.projects.create({ profile_id: profile.id, repo_id: repo.id, name: 'demo' });
  const session = s.sessions.create({
    id: 'a2f0c9d4-1111-4222-8333-444455556666',
    project_id: project.id,
    account_id: account.id,
    worktree_path: '/tmp/wt',
    base_branch: 'main',
    branch: 'alice/demo',
    agent_type: 'claude-code',
    title: 'demo',
    skip_permissions: false,
  });
  return { profile, account, repo, project, session };
}

describe('stores', () => {
  it('round-trips a profile with settings', () => {
    const s = stores();
    const p = s.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
    expect(p.branch_prefix).toBe('alice/');
    expect(s.profiles.getSettings(p.id).allowSkipPermissions).toBe(false);
    const patched = s.profiles.patchSettings(p.id, { allowSkipPermissions: true });
    expect(patched.allowSkipPermissions).toBe(true);
    expect(s.profiles.getSettings(p.id).allowSkipPermissions).toBe(true);
  });

  it('rejects duplicate profile names with a 409', () => {
    const s = stores();
    s.profiles.create({ name: 'alice', branch_prefix: '' });
    try {
      s.profiles.create({ name: 'alice', branch_prefix: '' });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(409);
    }
  });

  it('throws 404 for a missing row', () => {
    const s = stores();
    try {
      s.profiles.get(42);
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(404);
    }
  });

  it('maps account booleans', () => {
    const s = stores();
    const { account } = seedSession(s);
    expect(account.logged_in).toBe(false);
    s.accounts.setLoggedIn(account.id, true);
    expect(s.accounts.get(account.id).logged_in).toBe(true);
  });

  it('creates and transitions sessions', () => {
    const s = stores();
    const { session } = seedSession(s);
    expect(session.status).toBe('starting');
    const running = s.sessions.setStatus(session.id, 'running');
    expect(running.status).toBe('running');
    expect(s.sessions.list({ status: 'running' })).toHaveLength(1);
    expect(s.sessions.listActiveByRepo(1)).toHaveLength(1);
    s.sessions.setStatus(session.id, 'archived');
    expect(s.sessions.listActiveByRepo(1)).toHaveLength(0);
  });

  it('records events with JSON payloads', () => {
    const s = stores();
    const { session } = seedSession(s);
    s.events.record(session.id, 'created', { branch: 'alice/demo' });
    const events = s.events.list(session.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ branch: 'alice/demo' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run --project daemon
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/http/errors.ts`:

```ts
/**
 * Error carrying an HTTP status + machine-readable code. Thrown from stores
 * and services and rendered by the app-level error handler — a deliberate
 * shortcut over a separate domain-error hierarchy at this codebase's size.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static notFound(what: string, id: string | number): ApiError {
    return new ApiError(404, 'not_found', `${what} ${id} does not exist`);
  }

  static conflict(code: string, message: string): ApiError {
    return new ApiError(409, code, message);
  }

  static badRequest(code: string, message: string): ApiError {
    return new ApiError(400, code, message);
  }
}
```

`packages/daemon/src/db/migrations/001-initial.ts` (schema verbatim from SPEC §3):

```ts
export const migration001 = {
  version: 1,
  name: 'initial',
  sql: `
CREATE TABLE profiles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  branch_prefix TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  agent_type TEXT NOT NULL,
  label TEXT NOT NULL,
  config_dir TEXT NOT NULL,
  skip_permissions_default INTEGER NOT NULL DEFAULT 0,
  logged_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, agent_type, label)
);

CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  default_base_branch TEXT NOT NULL DEFAULT 'main',
  onboarding_notes TEXT,
  fetch_enabled INTEGER NOT NULL DEFAULT 1,
  last_fetched_at TEXT
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, name)
);

CREATE TABLE project_states (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  client_id TEXT NOT NULL,
  ui_state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, client_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  worktree_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  agent_session_ref TEXT,
  title TEXT,
  status TEXT NOT NULL,
  skip_permissions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT
);

CREATE TABLE prompts (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  title TEXT,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  project_id INTEGER REFERENCES projects(id),
  agent_type TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_accounts_profile ON accounts(profile_id);
CREATE INDEX idx_projects_profile ON projects(profile_id);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_events_session ON events(session_id);
`,
};
```

`packages/daemon/src/db/migrations/index.ts`:

```ts
import { migration001 } from './001-initial.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered, append-only. Schema changes always add a new entry (CLAUDE.md rule). */
export const MIGRATIONS: Migration[] = [migration001];
```

`packages/daemon/src/db/db.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations/index.js';

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    apply();
  }
}
```

`packages/daemon/src/db/stores/profiles.ts`:

```ts
import {
  profileSettingsSchema,
  type Profile,
  type ProfileSettings,
} from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  name: string;
  branch_prefix: string;
  settings: string;
  created_at: string;
}

function toProfile(r: Row): Profile {
  return { id: r.id, name: r.name, branch_prefix: r.branch_prefix, created_at: r.created_at };
}

export class ProfileStore {
  constructor(private readonly db: Db) {}

  create(input: { name: string; branch_prefix: string }): Profile {
    try {
      const info = this.db
        .prepare(`INSERT INTO profiles (name, branch_prefix, created_at) VALUES (?, ?, ?)`)
        .run(input.name, input.branch_prefix, new Date().toISOString());
      return this.get(Number(info.lastInsertRowid));
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict('profile_exists', `profile '${input.name}' already exists`);
      }
      throw e;
    }
  }

  list(): Profile[] {
    return (this.db.prepare(`SELECT * FROM profiles ORDER BY id`).all() as Row[]).map(toProfile);
  }

  get(id: number): Profile {
    const row = this.db.prepare(`SELECT * FROM profiles WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('profile', id);
    return toProfile(row);
  }

  getByName(name: string): Profile | undefined {
    const row = this.db.prepare(`SELECT * FROM profiles WHERE name = ?`).get(name) as
      | Row
      | undefined;
    return row ? toProfile(row) : undefined;
  }

  getSettings(id: number): ProfileSettings {
    const row = this.db.prepare(`SELECT settings FROM profiles WHERE id = ?`).get(id) as
      | Pick<Row, 'settings'>
      | undefined;
    if (!row) throw ApiError.notFound('profile', id);
    return profileSettingsSchema.parse(JSON.parse(row.settings));
  }

  patchSettings(id: number, patch: Record<string, unknown>): ProfileSettings {
    const merged = profileSettingsSchema.parse({ ...this.getSettings(id), ...patch });
    this.db.prepare(`UPDATE profiles SET settings = ? WHERE id = ?`).run(JSON.stringify(merged), id);
    return merged;
  }
}
```

`packages/daemon/src/db/stores/accounts.ts`:

```ts
import type { Account } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  profile_id: number;
  agent_type: string;
  label: string;
  config_dir: string;
  skip_permissions_default: number;
  logged_in: number;
  created_at: string;
}

function toAccount(r: Row): Account {
  return {
    id: r.id,
    profile_id: r.profile_id,
    agent_type: r.agent_type,
    label: r.label,
    config_dir: r.config_dir,
    skip_permissions_default: r.skip_permissions_default === 1,
    logged_in: r.logged_in === 1,
    created_at: r.created_at,
  };
}

export class AccountStore {
  constructor(private readonly db: Db) {}

  create(input: {
    profile_id: number;
    agent_type: string;
    label: string;
    config_dir: string;
    skip_permissions_default: boolean;
  }): Account {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO accounts (profile_id, agent_type, label, config_dir, skip_permissions_default, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.profile_id,
          input.agent_type,
          input.label,
          input.config_dir,
          input.skip_permissions_default ? 1 : 0,
          new Date().toISOString(),
        );
      return this.get(Number(info.lastInsertRowid));
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict(
          'account_exists',
          `account '${input.label}' for ${input.agent_type} already exists in this profile`,
        );
      }
      throw e;
    }
  }

  list(profileId?: number): Account[] {
    const rows = (
      profileId === undefined
        ? this.db.prepare(`SELECT * FROM accounts ORDER BY id`).all()
        : this.db.prepare(`SELECT * FROM accounts WHERE profile_id = ? ORDER BY id`).all(profileId)
    ) as Row[];
    return rows.map(toAccount);
  }

  get(id: number): Account {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('account', id);
    return toAccount(row);
  }

  setLoggedIn(id: number, loggedIn: boolean): void {
    this.db.prepare(`UPDATE accounts SET logged_in = ? WHERE id = ?`).run(loggedIn ? 1 : 0, id);
  }
}
```

`packages/daemon/src/db/stores/repos.ts`:

```ts
import type { Repo } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  path: string;
  default_base_branch: string;
  onboarding_notes: string | null;
  fetch_enabled: number;
  last_fetched_at: string | null;
}

function toRepo(r: Row): Repo {
  return {
    id: r.id,
    path: r.path,
    default_base_branch: r.default_base_branch,
    onboarding_notes: r.onboarding_notes,
    fetch_enabled: r.fetch_enabled === 1,
    last_fetched_at: r.last_fetched_at,
  };
}

export class RepoStore {
  constructor(private readonly db: Db) {}

  create(input: {
    path: string;
    default_base_branch: string;
    onboarding_notes: string | null;
    fetch_enabled: boolean;
  }): Repo {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO repos (path, default_base_branch, onboarding_notes, fetch_enabled) VALUES (?, ?, ?, ?)`,
        )
        .run(input.path, input.default_base_branch, input.onboarding_notes, input.fetch_enabled ? 1 : 0);
      return this.get(Number(info.lastInsertRowid));
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict('repo_exists', `repo at '${input.path}' is already registered`);
      }
      throw e;
    }
  }

  list(): Repo[] {
    return (this.db.prepare(`SELECT * FROM repos ORDER BY id`).all() as Row[]).map(toRepo);
  }

  get(id: number): Repo {
    const row = this.db.prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('repo', id);
    return toRepo(row);
  }

  getByPath(path: string): Repo | undefined {
    const row = this.db.prepare(`SELECT * FROM repos WHERE path = ?`).get(path) as Row | undefined;
    return row ? toRepo(row) : undefined;
  }

  patch(
    id: number,
    fields: Partial<Pick<Repo, 'default_base_branch' | 'onboarding_notes' | 'fetch_enabled'>>,
  ): Repo {
    const current = this.get(id);
    const next = { ...current, ...fields };
    this.db
      .prepare(
        `UPDATE repos SET default_base_branch = ?, onboarding_notes = ?, fetch_enabled = ? WHERE id = ?`,
      )
      .run(next.default_base_branch, next.onboarding_notes, next.fetch_enabled ? 1 : 0, id);
    return this.get(id);
  }

  setLastFetchedAt(id: number, iso: string): void {
    this.db.prepare(`UPDATE repos SET last_fetched_at = ? WHERE id = ?`).run(iso, id);
  }

  setOnboardingNotes(id: number, notes: string): void {
    this.db.prepare(`UPDATE repos SET onboarding_notes = ? WHERE id = ?`).run(notes, id);
  }
}
```

`packages/daemon/src/db/stores/projects.ts`:

```ts
import type { Project } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  profile_id: number;
  repo_id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export class ProjectStore {
  constructor(private readonly db: Db) {}

  create(input: { profile_id: number; repo_id: number; name: string }): Project {
    const now = new Date().toISOString();
    try {
      const info = this.db
        .prepare(
          `INSERT INTO projects (profile_id, repo_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.profile_id, input.repo_id, input.name, now, now);
      return this.get(Number(info.lastInsertRowid));
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict('project_exists', `project '${input.name}' already exists in this profile`);
      }
      throw e;
    }
  }

  list(profileId?: number): Project[] {
    return (
      profileId === undefined
        ? this.db.prepare(`SELECT * FROM projects ORDER BY id`).all()
        : this.db.prepare(`SELECT * FROM projects WHERE profile_id = ? ORDER BY id`).all(profileId)
    ) as Row[];
  }

  get(id: number): Project {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('project', id);
    return row;
  }

  touch(id: number): void {
    this.db
      .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }
}
```

`packages/daemon/src/db/stores/sessions.ts`:

```ts
import type { Session, SessionStatus } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: string;
  project_id: number;
  account_id: number;
  worktree_path: string;
  base_branch: string;
  branch: string;
  agent_type: string;
  agent_session_ref: string | null;
  title: string | null;
  status: SessionStatus;
  skip_permissions: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
}

export interface NewSessionRow {
  id: string;
  project_id: number;
  account_id: number;
  worktree_path: string;
  base_branch: string;
  branch: string;
  agent_type: string;
  title: string | null;
  skip_permissions: boolean;
}

function toSession(r: Row): Session {
  return { ...r, skip_permissions: r.skip_permissions === 1 };
}

const ACTIVE = `('starting', 'running', 'waiting_input', 'exited', 'interrupted')`;

export class SessionStore {
  constructor(private readonly db: Db) {}

  create(row: NewSessionRow): Session {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, account_id, worktree_path, base_branch, branch,
           agent_type, title, status, skip_permissions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
      )
      .run(
        row.id,
        row.project_id,
        row.account_id,
        row.worktree_path,
        row.base_branch,
        row.branch,
        row.agent_type,
        row.title,
        row.skip_permissions ? 1 : 0,
        now,
        now,
      );
    return this.get(row.id);
  }

  get(id: string): Session {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('session', id);
    return toSession(row);
  }

  list(filter: { project_id?: number; status?: SessionStatus } = {}): Session[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.project_id !== undefined) {
      clauses.push('project_id = ?');
      params.push(filter.project_id);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at`)
      .all(...params) as Row[];
    return rows.map(toSession);
  }

  listByStatus(statuses: SessionStatus[]): Session[] {
    const marks = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE status IN (${marks}) ORDER BY created_at`)
      .all(...statuses) as Row[];
    return rows.map(toSession);
  }

  listActiveByRepo(repoId: number): Session[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE p.repo_id = ? AND s.status IN ${ACTIVE}`,
      )
      .all(repoId) as Row[];
    return rows.map(toSession);
  }

  setStatus(id: string, status: SessionStatus): Session {
    this.db
      .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), id);
    return this.get(id);
  }

  setAgentSessionRef(id: string, ref: string): void {
    this.db.prepare(`UPDATE sessions SET agent_session_ref = ? WHERE id = ?`).run(ref, id);
  }

  setTitle(id: string, title: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, new Date().toISOString(), id);
  }

  setSkipPermissions(id: string, on: boolean): void {
    this.db.prepare(`UPDATE sessions SET skip_permissions = ? WHERE id = ?`).run(on ? 1 : 0, id);
  }

  touchActivity(id: string, iso: string): void {
    this.db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`).run(iso, id);
  }
}
```

`packages/daemon/src/db/stores/events.ts`:

```ts
import type { Db } from '../db.js';

export interface EventRow {
  id: number;
  session_id: string;
  type: string;
  payload: unknown;
  created_at: string;
}

export class EventStore {
  constructor(private readonly db: Db) {}

  record(sessionId: string, type: string, payload?: unknown): void {
    this.db
      .prepare(`INSERT INTO events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)`)
      .run(
        sessionId,
        type,
        payload === undefined ? null : JSON.stringify(payload),
        new Date().toISOString(),
      );
  }

  list(sessionId: string): EventRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as Array<Omit<EventRow, 'payload'> & { payload: string | null }>;
    return rows.map((r) => ({ ...r, payload: r.payload === null ? null : JSON.parse(r.payload) }));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run --project daemon
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): SQLite schema, migration runner and entity stores

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 10: Local security — token, Host/Origin guard, bearer auth

**Files:**
- Create: `packages/daemon/src/security/token.ts`, `packages/daemon/src/security/middleware.ts`
- Modify: `packages/daemon/src/http/app.ts`, `packages/daemon/test/version.test.ts`
- Test: `packages/daemon/test/security.test.ts`

**Interfaces:**
- Consumes: `PuddlePaths` (Task 7), `ApiError` (Task 9).
- Produces:
  - `ensureToken(paths: PuddlePaths): string` — loads `~/.puddle/token` or creates it (mode 0600, 64 hex chars).
  - `hostOriginGuard(): MiddlewareHandler` — 403 unless the `Host` hostname is localhost/127.0.0.1/::1; if an `Origin` header is present its hostname must also be local (any port — an SSH tunnel gives the browser origin `http://localhost:<local-port>`, which differs from the daemon port; rejecting on port would break SPEC §10's tunnel flow while adding nothing against DNS rebinding, whose attacker origin is never a local hostname).
  - `bearerAuth(token: string): MiddlewareHandler` — 401 unless `Authorization: Bearer <token>` (timing-safe compare).
  - `buildApp` deps gain `token: string`; guards apply to `/api/*` (static assets stay tokenless per SPEC §2; `/ws` is guarded in Task 22 at upgrade + first-message auth).
  - `errorHandler` registered on the app: `ApiError → { error: { code, message } }` with its status; anything else → 500 `internal`.

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/security.test.ts`:

```ts
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { ensureHome, resolvePaths } from '../src/paths.js';
import { ensureToken } from '../src/security/token.js';

const TOKEN = 't'.repeat(64);

function app() {
  return buildApp({ version: '0.0.1', assetsDir: null, token: TOKEN });
}

function get(path: string, headers: Record<string, string>) {
  return app().request(path, { headers: { host: 'localhost:7433', ...headers } });
}

describe('ensureToken', () => {
  it('creates a 0600 hex token once and reuses it', () => {
    const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-home-')));
    ensureHome(paths);
    const first = ensureToken(paths);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    expect(ensureToken(paths)).toBe(first);
    expect(readFileSync(paths.tokenFile, 'utf8').trim()).toBe(first);
  });
});

describe('local security middleware', () => {
  it('rejects /api requests without a token', async () => {
    const res = await get('/api/version', {});
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorised');
  });

  it('rejects a wrong token', async () => {
    const res = await get('/api/version', { authorization: `Bearer ${'x'.repeat(64)}` });
    expect(res.status).toBe(401);
  });

  it('accepts the right token on localhost', async () => {
    const res = await get('/api/version', { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it('rejects a non-local Host (DNS rebinding)', async () => {
    const res = await app().request('/api/version', {
      headers: { host: 'evil.example.com:7433', authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a foreign Origin, accepts a local one on any port', async () => {
    const bad = await get('/api/version', {
      authorization: `Bearer ${TOKEN}`,
      origin: 'https://evil.example.com',
    });
    expect(bad.status).toBe(403);
    const tunnelled = await get('/api/version', {
      authorization: `Bearer ${TOKEN}`,
      origin: 'http://localhost:9182',
    });
    expect(tunnelled.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run --project daemon
```

Expected: FAIL — `ensureToken` / new `buildApp` dep missing.

- [ ] **Step 3: Implement**

`packages/daemon/src/security/token.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { PuddlePaths } from '../paths.js';

/**
 * The browser-facing bearer token (SPEC §2 "Local security"). Generated once
 * at first start; the CLI reads this file (locally or over SSH) and hands it
 * to the browser as a URL fragment.
 */
export function ensureToken(paths: PuddlePaths): string {
  try {
    const existing = readFileSync(paths.tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // absent → generate below
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(paths.tokenFile, token + '\n', { mode: 0o600 });
  return token;
}
```

`packages/daemon/src/security/middleware.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../http/errors.js';

/** WHATWG URL keeps brackets on IPv6 hostnames, hence both spellings. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? '';
}

/**
 * Defeats DNS rebinding (Host must be a local name) and cross-site requests
 * (Origin, when present, must be a local origin). Ports are deliberately
 * ignored: through an SSH tunnel the browser's origin port is the local
 * tunnel port, not the daemon port.
 */
export function hostOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!LOCAL_HOSTNAMES.has(hostnameOf(c.req.header('host') ?? ''))) {
      throw new ApiError(403, 'forbidden_host', 'requests must address localhost');
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== 'null') {
      let local = false;
      try {
        local = LOCAL_HOSTNAMES.has(new URL(origin).hostname);
      } catch {
        local = false;
      }
      if (!local) throw new ApiError(403, 'forbidden_origin', 'cross-origin requests are not allowed');
    }
    await next();
  };
}

export function bearerAuth(token: string): MiddlewareHandler {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (c, next) => {
    const presented = Buffer.from(c.req.header('authorization') ?? '');
    const ok = presented.length === expected.length && timingSafeEqual(presented, expected);
    if (!ok) throw new ApiError(401, 'unauthorised', 'missing or invalid token');
    await next();
  };
}
```

Replace `packages/daemon/src/http/app.ts` with:

```ts
import { Hono } from 'hono';
import { ApiError } from './errors.js';
import { versionRoutes } from './routes/version.js';
import { staticAssets } from './static.js';
import { bearerAuth, hostOriginGuard } from '../security/middleware.js';

export interface AppDeps {
  version: string;
  /** Absolute dir of embedded UI assets; null in tests that don't exercise static serving. */
  assetsDir: string | null;
  token: string;
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    console.error('unhandled error:', err);
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });
  app.use('/api/*', hostOriginGuard());
  app.use('/api/*', bearerAuth(deps.token));
  app.route('/api/version', versionRoutes(deps.version));
  if (deps.assetsDir) app.use('*', staticAssets(deps.assetsDir));
  return app;
}
```

(The `err.status as 400` cast satisfies Hono's `ContentfulStatusCode` typing for a runtime-variable status; it is the standard Hono idiom.)

Update `packages/daemon/test/version.test.ts` and `packages/daemon/test/static.test.ts` to pass `token` and, for the version test, send the header:

```ts
// version.test.ts — new body
import { describe, expect, it } from 'vitest';
import { versionResponseSchema } from '@puddle/shared';
import { buildApp } from '../src/http/app.js';

describe('GET /api/version', () => {
  it('returns the daemon version', async () => {
    const app = buildApp({ version: '0.0.1', assetsDir: null, token: 'secret' });
    const res = await app.request('/api/version', {
      headers: { host: 'localhost:7433', authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    expect(versionResponseSchema.parse(await res.json()).version).toBe('0.0.1');
  });
});
```

In `static.test.ts`, change every `buildApp({ version: '0.0.1', assetsDir: ... })` call to include `token: 'secret'` (static requests send no token — that is the point being tested). Also update `src/index.ts`'s `buildApp` call to pass a placeholder `token: 'dev'` (replaced by the real composition root in Task 23).

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run --project daemon
```

Expected: PASS (including the untouched static tests — assets need no token).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): bearer token, Host/Origin guard and error envelope

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 11: Git plumbing — exec wrapper and per-repo mutex

**Files:**
- Create: `packages/daemon/src/git/exec.ts`, `packages/daemon/src/git/mutex.ts`
- Test: `packages/daemon/test/git.test.ts`

**Interfaces:**
- Produces:
  - `git(args: string[], opts?: { cwd?: string }): Promise<string>` — trimmed stdout; throws `GitError { args, exitCode, stderr }` on non-zero exit.
  - `class GitError extends Error`.
  - `class KeyedMutex { run<T>(key: string, fn: () => Promise<T>): Promise<T> }` — serialises `fn`s per key; a rejected `fn` must not wedge the queue. **Not reentrant** — callers must never call `run` for the same key inside a held `run` (Task 12 is structured around this).

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/git.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { git, GitError } from '../src/git/exec.js';
import { KeyedMutex } from '../src/git/mutex.js';

describe('git exec', () => {
  it('returns trimmed stdout', async () => {
    expect(await git(['--version'])).toMatch(/^git version /);
  });

  it('throws GitError with stderr on failure', async () => {
    try {
      await git(['rev-parse', 'HEAD'], { cwd: '/' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GitError);
      expect((e as GitError).stderr.length).toBeGreaterThan(0);
    }
  });
});

describe('KeyedMutex', () => {
  it('serialises work per key and isolates keys', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const slow = mutex.run('a', async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push('a1');
    });
    const queued = mutex.run('a', async () => {
      order.push('a2');
    });
    const other = mutex.run('b', async () => {
      order.push('b1');
    });
    await Promise.all([slow, queued, other]);
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a1')); // key b did not wait for key a
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2')); // key a serialised
  });

  it('keeps the queue alive after a rejection', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await mutex.run('a', async () => 'still works')).toBe('still works');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run --project daemon
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/git/exec.ts`:

```ts
import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/** All puddle git operations go through here: uniform errors, no shell quoting. */
export function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === 'number' ? err.code : null;
          reject(new GitError(args, code, stderr || err.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}
```

`packages/daemon/src/git/mutex.ts`:

```ts
/**
 * Serialises async work per key. Used with key `repo:<id>` because concurrent
 * `git worktree`/`git fetch` invocations on one repo race on git's own lock
 * files and fail spuriously (SPEC §3). Not reentrant: nesting run() calls for
 * the same key deadlocks — WorktreeManager keeps all repo work single-level.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn); // run regardless of the predecessor's fate
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run --project daemon
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): git exec wrapper and per-repo mutex

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 12: Worktree manager — create, remove, fetch policy, branch naming, orphans

**Files:**
- Create: `packages/daemon/src/worktrees/manager.ts`, `packages/daemon/src/worktrees/slug.ts`
- Modify: `packages/daemon/src/db/stores/sessions.ts` (add `allIds(): string[]`)
- Test: `packages/daemon/test/worktrees.test.ts`, `packages/daemon/test/helpers/git-fixtures.ts`

**Interfaces:**
- Consumes: `git`/`GitError` and `KeyedMutex` (Task 11), `PuddlePaths` (7), `RepoStore`/`SessionStore`/`ApiError` (9), `Repo` from shared (8).
- Produces:
  - `slugify(title: string | null | undefined): string` — lowercase, `[^a-z0-9]+`→`-`, trimmed, ≤40 chars, may be `''`.
  - `interface CreateWorktreeResult { worktreePath: string; branch: string; baseBranch: string; baseRef: string }`.
  - `class WorktreeManager`:
    - `constructor(deps: { paths: PuddlePaths; mutex: KeyedMutex; repos: RepoStore; sessions: SessionStore })`
    - `create(opts: { repo: Repo; sessionId: string; baseBranch?: string; requestedBranch?: string; title?: string | null; branchPrefix: string }): Promise<CreateWorktreeResult>` — under the repo mutex: create-time fetch (failure logged, never blocks — SPEC §4), base resolves to `origin/<base>` when that remote ref exists (400 `unknown_base` if neither ref exists), branch defaults to `<branchPrefix><slug(title)>` or the session id's first 8 chars, collision with **any** existing local or remote branch appends `-2`, `-3`, …, then `git worktree add <path> -b <branch> <baseRef>`, ensures `.puddle/` is in the repo's `info/exclude`, and creates `<worktree>/.puddle/`.
    - `remove(opts: { repo: Repo; worktreePath: string; force?: boolean }): Promise<void>` — 409 `worktree_dirty` unless clean or forced; a missing dir just prunes.
    - `isClean(worktreePath: string): Promise<boolean>`.
    - `fetchRepo(repo: Repo): Promise<void>` — public mutexed fetch (project-open, periodic, manual `POST /fetch`); throws on failure; updates `last_fetched_at`; no-ops when `fetch_enabled` is false or no `origin` remote.
    - `findOrphanWorktrees(repo: Repo): string[]` — dirs under `worktrees/<repo.id>/` with no session row of that id (never deletes — SPEC §4 reconcile).
  - `SessionStore.allIds(): string[]` (new method).

- [ ] **Step 1: Write the git fixture helper and failing tests**

`packages/daemon/test/helpers/git-fixtures.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A repo with one commit on main and identity configured. */
export function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-repo-'));
  sh(dir, 'init', '-b', 'main');
  sh(dir, 'config', 'user.email', 'alice@example.com');
  sh(dir, 'config', 'user.name', 'alice');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-m', 'initial');
  return dir;
}

/** Clone `src` so the clone has an `origin` remote pointing at it. */
export function cloneRepo(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-clone-'));
  execFileSync('git', ['clone', src, dir], { encoding: 'utf8' });
  sh(dir, 'config', 'user.email', 'alice@example.com');
  sh(dir, 'config', 'user.name', 'alice');
  return dir;
}

export function commitFile(repo: string, name: string, contents: string): string {
  writeFileSync(join(repo, name), contents);
  sh(repo, 'add', name);
  sh(repo, 'commit', '-m', `add ${name}`);
  return sh(repo, 'rev-parse', 'HEAD');
}
```

`packages/daemon/test/worktrees.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/db.js';
import { RepoStore } from '../src/db/stores/repos.js';
import { SessionStore } from '../src/db/stores/sessions.js';
import { KeyedMutex } from '../src/git/mutex.js';
import { ApiError } from '../src/http/errors.js';
import { ensureHome, resolvePaths } from '../src/paths.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { slugify } from '../src/worktrees/slug.js';
import { cloneRepo, commitFile, initRepo, sh } from './helpers/git-fixtures.js';

function setup(repoPath: string) {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-home-')));
  ensureHome(paths);
  const db = openDatabase(paths.dbFile);
  const repos = new RepoStore(db);
  const sessions = new SessionStore(db);
  const repo = repos.create({
    path: repoPath,
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: true,
  });
  const manager = new WorktreeManager({ paths, mutex: new KeyedMutex(), repos, sessions });
  return { paths, repos, sessions, repo, manager };
}

describe('slugify', () => {
  it('produces branch-safe slugs', () => {
    expect(slugify('Fix: teleop latency (v2)!')).toBe('fix-teleop-latency-v2');
    expect(slugify(null)).toBe('');
  });
});

describe('WorktreeManager.create', () => {
  it('branches from origin/<base> so a stale local base is never used', async () => {
    const origin = initRepo();
    const clone = cloneRepo(origin);
    const tip = commitFile(origin, 'new.txt', 'fresh'); // origin advances after the clone
    const { manager, repo } = setup(clone);
    const result = await manager.create({ repo, sessionId: randomUUID(), title: 'demo', branchPrefix: 'alice/' });
    expect(result.baseRef).toBe('origin/main');
    expect(sh(result.worktreePath, 'rev-parse', 'HEAD')).toBe(tip);
    expect(result.branch).toBe('alice/demo');
    expect(sh(result.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('alice/demo');
  });

  it('falls back to the local base when there is no remote', async () => {
    const repoPath = initRepo();
    const { manager, repo } = setup(repoPath);
    const result = await manager.create({ repo, sessionId: randomUUID(), title: 'demo', branchPrefix: '' });
    expect(result.baseRef).toBe('main');
  });

  it('suffixes on branch-name collision instead of failing', async () => {
    const repoPath = initRepo();
    const { manager, repo } = setup(repoPath);
    const a = await manager.create({ repo, sessionId: randomUUID(), title: 'demo', branchPrefix: '' });
    const b = await manager.create({ repo, sessionId: randomUUID(), title: 'demo', branchPrefix: '' });
    expect(a.branch).toBe('demo');
    expect(b.branch).toBe('demo-2');
  });

  it('uses the session short id when there is no title', async () => {
    const repoPath = initRepo();
    const { manager, repo } = setup(repoPath);
    const sid = randomUUID();
    const result = await manager.create({ repo, sessionId: sid, branchPrefix: 'alice/' });
    expect(result.branch).toBe(`alice/${sid.slice(0, 8)}`);
  });

  it('rejects an unknown base branch', async () => {
    const repoPath = initRepo();
    const { manager, repo } = setup(repoPath);
    await expect(
      manager.create({ repo, sessionId: randomUUID(), baseBranch: 'nope', branchPrefix: '' }),
    ).rejects.toMatchObject({ code: 'unknown_base' });
  });

  it('creates a git-excluded .puddle dir', async () => {
    const repoPath = initRepo();
    const { manager, repo } = setup(repoPath);
    const { worktreePath } = await manager.create({ repo, sessionId: randomUUID(), title: 'x', branchPrefix: '' });
    expect(existsSync(join(worktreePath, '.puddle'))).toBe(true);
    writeFileSync(join(worktreePath, '.puddle', 'onboarding-notes.md'), 'notes');
    expect(await manager.isClean(worktreePath)).toBe(true); // .puddle/ is excluded
  });
});

describe('WorktreeManager.remove', () => {
  it('refuses a dirty worktree without force, removes with force', async () => {
    const repoPath = initRepo();
    const { manager, repo } = setup(repoPath);
    const { worktreePath } = await manager.create({ repo, sessionId: randomUUID(), title: 'x', branchPrefix: '' });
    writeFileSync(join(worktreePath, 'dirty.txt'), 'uncommitted');
    await expect(manager.remove({ repo, worktreePath })).rejects.toMatchObject({ code: 'worktree_dirty' });
    await manager.remove({ repo, worktreePath, force: true });
    expect(existsSync(worktreePath)).toBe(false);
    expect(sh(repoPath, 'branch', '--list', 'x')).toContain('x'); // branch survives archiving
  });
});

describe('orphan detection', () => {
  it('flags worktree dirs with no session row', async () => {
    const repoPath = initRepo();
    const { manager, repo, paths } = setup(repoPath);
    mkdirSync(join(paths.worktreesDir, String(repo.id), 'stray-dir'), { recursive: true });
    expect(manager.findOrphanWorktrees(repo)).toEqual([
      join(paths.worktreesDir, String(repo.id), 'stray-dir'),
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run --project daemon
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/worktrees/slug.ts`:

```ts
/** Branch-name-safe slug from a session title; may legitimately be ''. */
export function slugify(title: string | null | undefined): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}
```

Add to `packages/daemon/src/db/stores/sessions.ts` (inside `SessionStore`):

```ts
  allIds(): string[] {
    return (this.db.prepare(`SELECT id FROM sessions`).all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
  }
```

`packages/daemon/src/worktrees/manager.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Repo } from '@puddle/shared';
import type { SessionStore } from '../db/stores/sessions.js';
import type { RepoStore } from '../db/stores/repos.js';
import { git } from '../git/exec.js';
import type { KeyedMutex } from '../git/mutex.js';
import { ApiError } from '../http/errors.js';
import type { PuddlePaths } from '../paths.js';
import { slugify } from './slug.js';

export interface CreateWorktreeResult {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseRef: string;
}

export class WorktreeManager {
  constructor(
    private readonly deps: {
      paths: PuddlePaths;
      mutex: KeyedMutex;
      repos: RepoStore;
      sessions: SessionStore;
    },
  ) {}

  /**
   * All repo-mutating work runs under the repo mutex. The fetch inside create
   * calls the unmutexed core directly — KeyedMutex is not reentrant.
   */
  create(opts: {
    repo: Repo;
    sessionId: string;
    baseBranch?: string;
    requestedBranch?: string;
    title?: string | null;
    branchPrefix: string;
  }): Promise<CreateWorktreeResult> {
    const { repo } = opts;
    return this.deps.mutex.run(`repo:${repo.id}`, async () => {
      const baseBranch = opts.baseBranch ?? repo.default_base_branch;
      await this.fetchCoreQuietly(repo);
      const baseRef = (await this.refExists(repo, `refs/remotes/origin/${baseBranch}`))
        ? `origin/${baseBranch}`
        : baseBranch;
      if (baseRef === baseBranch && !(await this.refExists(repo, `refs/heads/${baseBranch}`))) {
        throw ApiError.badRequest('unknown_base', `base branch '${baseBranch}' does not exist`);
      }
      const branch = await this.pickBranchName(repo, opts);
      const worktreePath = this.deps.paths.sessionWorktreeDir(repo.id, opts.sessionId);
      mkdirSync(dirname(worktreePath), { recursive: true });
      await git(['worktree', 'add', worktreePath, '-b', branch, baseRef], { cwd: repo.path });
      await this.excludePuddleDir(repo);
      mkdirSync(join(worktreePath, '.puddle'), { recursive: true });
      return { worktreePath, branch, baseBranch, baseRef };
    });
  }

  remove(opts: { repo: Repo; worktreePath: string; force?: boolean }): Promise<void> {
    return this.deps.mutex.run(`repo:${opts.repo.id}`, async () => {
      if (!existsSync(opts.worktreePath)) {
        await git(['worktree', 'prune'], { cwd: opts.repo.path }).catch(() => undefined);
        return;
      }
      if (!opts.force && !(await this.isClean(opts.worktreePath))) {
        throw ApiError.conflict(
          'worktree_dirty',
          'worktree has uncommitted changes; archive with force to discard them',
        );
      }
      const args = ['worktree', 'remove', ...(opts.force ? ['--force'] : []), opts.worktreePath];
      await git(args, { cwd: opts.repo.path });
    });
  }

  async isClean(worktreePath: string): Promise<boolean> {
    return (await git(['status', '--porcelain'], { cwd: worktreePath })) === '';
  }

  /** Mutexed fetch for project-open, periodic and manual fetches. Throws on failure. */
  fetchRepo(repo: Repo): Promise<void> {
    return this.deps.mutex.run(`repo:${repo.id}`, () => this.fetchCore(repo));
  }

  findOrphanWorktrees(repo: Repo): string[] {
    const dir = join(this.deps.paths.worktreesDir, String(repo.id));
    if (!existsSync(dir)) return [];
    const known = new Set(this.deps.sessions.allIds());
    return readdirSync(dir)
      .filter((name) => !known.has(name))
      .map((name) => join(dir, name));
  }

  private async fetchCore(repo: Repo): Promise<void> {
    if (!repo.fetch_enabled) return;
    if (!(await this.hasOrigin(repo))) return; // no remote → freshness degrades silently (SPEC §4)
    await git(['fetch', 'origin'], { cwd: repo.path });
    this.deps.repos.setLastFetchedAt(repo.id, new Date().toISOString());
  }

  /** Create-time fetch: failures are logged, never block session creation (SPEC §4). */
  private async fetchCoreQuietly(repo: Repo): Promise<void> {
    try {
      await this.fetchCore(repo);
    } catch (e) {
      console.warn(`fetch failed for ${repo.path}: ${(e as Error).message}`);
    }
  }

  private async hasOrigin(repo: Repo): Promise<boolean> {
    const remotes = await git(['remote'], { cwd: repo.path });
    return remotes.split('\n').includes('origin');
  }

  private async refExists(repo: Repo, ref: string): Promise<boolean> {
    try {
      await git(['rev-parse', '--verify', '--quiet', ref], { cwd: repo.path });
      return true;
    } catch {
      return false;
    }
  }

  private async pickBranchName(
    repo: Repo,
    opts: { requestedBranch?: string; branchPrefix: string; title?: string | null; sessionId: string },
  ): Promise<string> {
    const wanted =
      opts.requestedBranch ??
      `${opts.branchPrefix}${slugify(opts.title) || opts.sessionId.slice(0, 8)}`;
    const refs = await git(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
      { cwd: repo.path },
    );
    const taken = new Set(
      refs
        .split('\n')
        .filter(Boolean)
        .map((r) => r.replace(/^origin\//, '')),
    );
    if (!taken.has(wanted)) return wanted;
    for (let n = 2; ; n++) {
      const candidate = `${wanted}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** `.puddle/` is never committed: exclude it once per repo (shared by all worktrees). */
  private async excludePuddleDir(repo: Repo): Promise<void> {
    const commonDirRaw = await git(['rev-parse', '--git-common-dir'], { cwd: repo.path });
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(repo.path, commonDirRaw);
    const infoDir = join(commonDir, 'info');
    mkdirSync(infoDir, { recursive: true });
    const excludeFile = join(infoDir, 'exclude');
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    if (!current.split('\n').includes('.puddle/')) {
      appendFileSync(excludeFile, (current.endsWith('\n') || current === '' ? '' : '\n') + '.puddle/\n');
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run --project daemon
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): worktree manager with fetch policy, branch naming and orphan detection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Remaining tasks (outline — implemented directly against SPEC.md, test-first)

The detailed code lives in the codebase, not this document. Each task = failing test → implement → commit.

- **Task 13 — Agent adapters.** `agents/adapter.ts` (AgentAdapter interface + LaunchOpts per SPEC §5), `agents/claude-code.ts` (env `CLAUDE_CONFIG_DIR`; launch `--session-id <uuid>` reusing the puddle session id; resume `--resume <ref> [prompt]`; skip `--dangerously-skip-permissions`; login `auth login`; statusPatterns; **flags verified against 2.1.207 — record in comment**), `agents/registry.ts`.
- **Task 14 — LogStore.** Append-only `logs/<sid>/<term>.log`, lazy write streams, `readTail` (last `replayBytes`), `listTerms`, close handling.
- **Task 15 — ANSI strip + StatusDetector.** `pty/ansi.ts`; detector: any output → running (activity), waitingInput pattern + ~2 s quiet → waiting_input, busy pattern suppresses, limitReached callback.
- **Task 16 — PtyManager.** node-pty spawn keyed `(stream, term)`, tee to LogStore (opt-out for login PTYs), write/resize/kill/killAll, `note()` for daemon-injected terminal lines, data/exit events.
- **Task 17 — CRUD routes + app assembly.** profiles (+settings), accounts (mkdir fresh config dir), repos (git validation, PATCH, manual fetch, orphan list), projects (detail + fire-and-forget open-fetch, archive), config GET/PATCH. All zod-validated via shared schemas.
- **Task 18 — Onboarding.** Preamble builder (SPEC §4 semantics: apply what notes settle, ask what they leave open, teach-rules instruction) + `.puddle/onboarding-notes.md` watcher syncing to `repos.onboarding_notes` with previous-notes event.
- **Task 19 — SessionService.** create (account∈profile check, server-side gate: requested ∧ gate ∧ opt-in else 400; worktree; preamble only on fresh worktrees; spawn; resolveSessionRef), resume (exited/interrupted only; gate re-eval with silent downgrade + terminal note; interrupted-resume injected message), kill, archive (clean-or-force; project archive refuses live sessions unless forced), spawnShell, status wiring (starting→running on first output; detector transitions; last_activity throttle; events audit trail).
- **Task 20 — Reconcile + periodic fetch.** Boot pass: live-ish statuses → interrupted (+event); re-register notes watchers; optional autoResume. Interval fetch for repos with active sessions.
- **Task 21 — Session routes + account login PTY.** REST per SPEC §6; login PTY stream `login-<accountId>`, exit 0 → `logged_in`.
- **Task 22 — WS gateway.** First-message token auth; attach (log-tail replay → live), stdin/resize/detach, spawn-shell, subscribe-status broadcast; multi-viewer last-writer-wins sizing.
- **Task 23 — Composition root.** `daemon.ts` `createDaemon()` assembling everything (injectable adapters for tests), `index.ts` bin with signal handling; `serve` + `ws` WebSocketServer wiring.
- **Task 24 — E2E.** Fake bash adapter; full lifecycle test incl. two accounts interleaved streaming, restart → interrupted → resume → replay, token rejection, closed-gate 400, notes sync.
- **Task 25 — Acceptance + docs.** `docs/acceptance/phase-1.md` (manual curl/wscat script with real claude per SPEC §14), CHANGELOG, CLAUDE.md housekeeping.


