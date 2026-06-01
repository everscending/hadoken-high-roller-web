# Cloudflare Worker Deployment Plan — Complete

## Overview

This document outlines the plan for adding a Cloudflare Workers + D1 deployment target to the Hadoken High Roller codebase while preserving the existing Electron desktop application build. The app will support two runtime environments:

1. **Electron** — the existing desktop build (unchanged)
2. **Cloudflare Workers** — a new web deployment using D1 for persistence

---

## 1. Architecture Overview

### Current Architecture (Electron Only)

```
┌─────────────────────────────────────┐
│           Renderer (React)          │  ← Browser / Chromium
│   window.api.* → IPC → Main Process │
└──────────────┬──────────────────────┘
               │ IPC (electron ipcMain)
┌──────────────▼──────────────────────┐
│           Main Process              │  ← Node.js runtime
│   better-sqlite3 (local file DB)    │
└─────────────────────────────────────┘
```

### Target Architecture (Dual-Target)

```
                    ┌──────────────────────────┐
                    │     Electron Build       │
                    │                          │
Renderer (React) ──►│ IPC → Main Process       │──► better-sqlite3 (local file)
                    └──────────────────────────┘

                    ┌──────────────────────────┐
                    │    Cloudflare Build      │
                    │                          │
Renderer (React) ──►│ Fetch API → Worker       │──► Cloudflare D1
                    └──────────────────────────┘
```

The **renderer (React UI)** is shared between both targets. The **data access layer** diverges:
- Electron uses IPC → Node.js main process → `better-sqlite3`
- Cloudflare uses HTTP fetch → Worker route handlers → D1

### Data Access Layer Diagram

```
┌───────────────────────────────────────────────┐
│              Data Access Layer                │
│                                               │
│  ┌──────────────┐    ┌─────────────────────┐  │
│  │  DB Adapter   │    │  DB Adapter         │  │
│  │  Interface     │◄──►│  (Electron)         │  │
│  │  (shared)     │    │  better-sqlite3     │  │
│  └──────────────┘    └─────────────────────┘  │
│                    ┌─────────────────────┐     │
│                    │  DB Adapter         │     │
│                    │  (Cloudflare)       │     │
│                    │  D1 via env.DB      │     │
│                    └─────────────────────┘     │
└───────────────────────────────────────────────┘
```

---

## 2. Key Considerations

### 2.1 Runtime Environment Differences

| Concern | Electron (Main Process) | Cloudflare Worker |
|---|---|---|
| Runtime | Node.js (full) | V8 isolate (limited) |
| File System Access | `fs`, `path.join` | Not available |
| Native Modules | `better-sqlite3` | Not supported |
| IPC Mechanism | `ipcMain` / `ipcRenderer` | HTTP REST API (fetch) |
| Persistence | SQLite file on disk | Cloudflare D1 (SQLite-compatible API) |
| Environment Variables | `process.env` | `env.*` bindings |
| Lifecycle Hooks | `app.whenReady()`, `before-quit` | Request/response lifecycle only |
| Concurrency | Single-threaded (Node event loop) | Per-request isolation, auto-scaled |
| Module System | CommonJS (main/preload) | ES Modules only |

**Implication:** The data access layer must be abstracted behind a unified interface so the renderer can call `api.getOrCreatePlayer()` regardless of which runtime it is in.

### 2.2 Database Abstraction Layer (Critical)

This is the most significant architectural change. The current code couples `better-sqlite3` directly to IPC handlers in a single file (`src/main/database.ts`). All 332 lines of database logic, schema creation, and IPC handlers are monolithically embedded together with no abstraction.

**Required interface methods:**
- `getOrCreatePlayer(name: string): Promise<Player>`
- `startGame(playerId: number, startingBalance: number): Promise<{ gameId: number }>`
- `recordSpin(gameId: number, symbols: string, betAmount: number, winAmount: number): Promise<{ spinId: number }>`
- `endGame(gameId: number, endingBalance: number): Promise<void>`
- `getLeaderboard(): Promise<LeaderboardEntry[]>`

**Implementation approach:**
1. Create a shared `src/lib/database/adapter.ts` defining the interface
2. Implement `src/main/database-adapter-electron.ts` wrapping existing `better-sqlite3` logic
3. Implement `src/lib/database/adapter-d1.ts` using D1's prepared statement API
4. The Electron main process uses the Electron adapter; the Cloudflare Worker uses the D1 adapter

**Important detail from codebase analysis:** The `record-spin` handler does more than just insert a spin record. It also:
- Verifies the game exists
- Calculates the current balance via a JOIN query across `games` and `spins` tables
- Updates player stats (`total_spins`, `highest_balance`) in the same flow

This multi-step logic must be preserved in both adapters. The D1 adapter will need to use `db.batch()` for multi-statement operations instead of `better-sqlite3`'s synchronous single-connection model.

### 2.3 IPC vs HTTP Communication

**Current:** Renderer calls `window.api.getOrCreatePlayer()` → `ipcRenderer.invoke('get-or-create-player', ...)` → main process handler.

**Cloudflare:** Renderer calls `fetch('/api/player/create', { method: 'POST', body: JSON.stringify({ name }) })` → Worker route handler.

**Solution — Unified API Bridge:**
Create a single `window.api` interface that works in both environments:

```typescript
// src/lib/api-bridge.ts (shared)
class ApiBridge {
  private isCloudflare = /* runtime detection */

  async getOrCreatePlayer(name: string): Promise<Player> {
    if (this.isCloudflare) {
      const res = await fetch('/api/player/create', { /* ... */ })
      return res.json()
    }
    // Electron path — uses existing IPC
    return window.api.getOrCreatePlayer(name)
  }

  // ... other methods follow same pattern
}
```

**Environment detection:** Check for the presence of Electron-specific globals (`window.electron`, `process.versions.electron`) to determine which transport to use.

**Cloudflare Worker API routes needed:**
| Route | Method | Action |
|---|---|---|
| `/api/player/create` | POST | `getOrCreatePlayer` |
| `/api/game/start` | POST | `startGame` |
| `/api/spin/record` | POST | `recordSpin` |
| `/api/game/end` | POST | `endGame` |
| `/api/leaderboard` | GET | `getLeaderboard` |

### 2.4 Build System Changes

The current build uses `electron-vite` which bundles three targets: main, preload, renderer. We need to add a fourth target for Cloudflare Workers.

**Proposed structure:**
```
hadoken-high-roller/
├── src/
│   ├── lib/                              # Shared code (both targets)
│   │   ├── database/
│   │   │   ├── adapter.ts                # DB interface definition
│   │   │   └── schema.sql                # D1 migration SQL (shared)
│   │   ├── api-bridge.ts                 # Unified API bridge for renderer
│   │   └── types/                        # Shared TypeScript types
│   ├── main/                             # Electron-only (main process)
│   │   ├── index.ts                      # App entry point
│   │   └── database-adapter-electron.ts  # Electron DB adapter (extracted)
│   ├── preload/                          # Electron-only (preload script)
│   │   ├── index.ts                      # IPC bridge
│   │   └── index.d.ts                    # Type declarations (types moved to shared)
│   ├── worker/                           # Cloudflare Worker (NEW)
│   │   ├── index.ts                      # Entry point + route handlers
│   │   └── routes/                       # API route modules (optional split)
│   └── renderer/                         # Shared (React UI)
│       ├── index.html
│       └── src/
├── electron.vite.config.ts               # Unchanged (Electron build)
├── vite.config.worker.ts                 # NEW - Worker build config
├── tsconfig.node.json                    # Unchanged (main + preload)
├── tsconfig.web.json                     # Updated to include shared types
├── tsconfig.worker.json                  # NEW - Worker TS config
├── wrangler.toml                         # NEW - Cloudflare configuration
└── package.json                          # New scripts + dev dependencies
```

**Build configuration changes:**

1. **`vite.config.worker.ts`** — New Vite config for Cloudflare Worker build:
   - Single entry point (`src/worker/index.ts`)
   - Externalize all dependencies (Worker runtime)
   - Output as ES module compatible with Workers

2. **`package.json` scripts additions:**
   ```json
   {
     "build:worker": "vite build --config vite.config.worker.ts",
     "dev:worker": "wrangler dev --port 8787"
   }
   ```

3. **`electron.vite.config.ts`** — Keep unchanged (Electron build stays as-is)

4. **TypeScript configuration:**
   - Add `tsconfig.worker.json` extending base config
   - Ensure shared types are accessible from both main and worker configs

### 2.5 Cloudflare D1 Database Setup

**D1 is a SQLite-compatible database.** The existing SQL schema from `better-sqlite3` will largely work as-is, but there are important differences:

**Schema migration:**
```sql
-- src/lib/database/schema.sql (D1 migration)
CREATE TABLE IF NOT EXISTS players (
  player_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,          -- Add UNIQUE constraint for upsert logic
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  highest_balance INTEGER DEFAULT 0,
  total_spins INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
  game_id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  end_time TIMESTAMP,
  starting_balance INTEGER NOT NULL,
  ending_balance INTEGER
);

CREATE TABLE IF NOT EXISTS spins (
  spin_id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(game_id),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  symbols TEXT NOT NULL,
  bet_amount INTEGER NOT NULL,
  win_amount INTEGER NOT NULL
);
```

**D1 API differences from `better-sqlite3`:**
| Feature | better-sqlite3 | D1 (Cloudflare) |
|---|---|---|
| Prepared statements | `db.prepare(sql).get(params)` | `db.prepare(sql).bind(...).run()` |
| Binding syntax | Positional (`?`) or named (`:name`) | Positional (array) or named (object) |
| Result format | Direct row object / array | `{ success: boolean, meta: {}, results: [] }` |
| Transactions | `db.transaction(fn)` | `db.batch([stmt1, stmt2])` |
| Auto-increment readback | `result.lastInsertRowid` | Read back via `SELECT MAX(id)` or return in batch |
| WAL mode | Supported | N/A (managed by Cloudflare) |

**D1 binding configuration (`wrangler.toml`):**
```toml
[[d1_databases]]
binding = "DB"
database_name = "hadoken-high-roller"
database_id = "<uuid>"
migrations_dir = "src/lib/database/migrations"
```

### 2.6 Electron-Specific Dependencies

These dependencies are **Electron-only** and must not be bundled into the Cloudflare Worker build:

| Dependency | Used In | Cloudflare Compatible? |
|---|---|---|
| `better-sqlite3` | Main process (database) | Native module, not supported |
| `electron-store` | Declared but unused in codebase | File system dependent |
| `@electron-toolkit/preload` | Preload script | Electron-only |
| `@electron-toolkit/utils` | Main process | Electron-only |
| `electron`, `electron-builder` | Build tooling | Not needed for Worker |

**Resolution:**
- These are already handled by `externalizeDepsPlugin` in the Electron build
- The Worker build must explicitly exclude them via Vite's `noExternal` / `optimizeDeps` configuration
- The shared code paths must not import any Electron-specific modules

### 2.7 Renderer Environment Detection & Conditional Loading

The renderer currently assumes `window.api` is always available via the Electron preload script. For Cloudflare deployment:

**Changes needed in renderer:**

1. **Remove Electron-specific preload injection from web build** — The preload script (`src/preload/index.ts`) must be conditionally included only in the Electron build. The `electron.vite.config.ts` already handles this via separate entry points for main/preload vs renderer, but the web build must not reference preload at all.

2. **API bridge initialization** — The renderer must initialize its API bridge based on the runtime:
   ```typescript
   // In main.tsx or a dedicated init module
   if (typeof window !== 'undefined' && !window.electron) {
     // Cloudflare / web environment — use fetch-based API bridge
     window.api = new ApiBridge()
   }
   // Electron environment — preload script already sets window.api via IPC
   ```

3. **Type declarations** — Move the `AppAPI`, `Player`, `LeaderboardEntry` types from `src/preload/index.d.ts` to a shared location (`src/lib/types/api.ts`). The preload script should re-export from the shared types.

4. **TypeScript config update** — `tsconfig.web.json` must include the shared types directory in its `include` path so the renderer can resolve them.

### 2.8 Static Assets (Images, Sounds)

The renderer imports images and audio files via Vite's asset handling:
```typescript
import symbol1 from '../assets/symbols/balrog.png'
import youWonSoundUrl from '../assets/sounds/youwin.mp3?url'
```

**Consideration:** These assets are bundled by Vite in both builds. In the Cloudflare Worker build, they will be included in the Worker's bundled output (Workers support assets up to the bundle size limit). For very large asset collections, consider using Cloudflare R2 or a CDN.

**Current assets are small enough** (16 PNG icons, 10 MP3 sounds) that bundling into the Worker is acceptable.

### 2.9 Third-Party Library Compatibility

| Library | Electron Compatible? | Cloudflare Worker Compatible? | Notes |
|---|---|---|---|
| `react` / `react-dom` | Yes | Yes | Standard web libraries |
| `react-router-dom` | Yes | Yes | MemoryRouter works in both; consider switching to HashRouter for SPA routing on Workers |
| `three` (0.134.0) | Yes | Partially | Three.js uses Web Workers internally; may need `Worker` polyfill or bundling config for Cloudflare |
| `vanta` (0.5.24) | Yes | Partially | Depends on Three.js; same concerns apply. Also uses `requestAnimationFrame` which works in Workers but may need attention |
| `@electron-toolkit/*` | Yes | No | Must be excluded from Worker build |
| `better-sqlite3` | Yes | No | Native module, replaced by D1 adapter |
| `electron-store` | Yes | No | File system dependent, not needed for Worker |

**Action items:**
- Test Three.js + Vanta in a Worker environment; if `Worker` constructor is unavailable, configure Vite to inline the Three.js web worker
- Consider using `HashRouter` instead of `MemoryRouter` for better compatibility with Cloudflare Workers (enables direct URL sharing and browser back/forward)

### 2.10 CORS & Security Considerations

When the renderer is served from a different origin than the Worker API (e.g., static site on Cloudflare Pages vs. Worker), CORS headers must be configured:

**Worker response middleware:**
```typescript
// In worker index.ts — add CORS headers to all API responses
function withCors(response: Response): Response {
  return new Response(response.body, {
    ...response,
    headers: {
      ...Object.fromEntries(response.headers),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}

// Handle preflight requests
if (request.method === 'OPTIONS') {
  return new Response(null, { status: 204 })
}
```

**For Electron deployment:** CORS is not a concern (same origin via `file://` protocol). The API bridge handles this transparently.

### 2.11 State Management & Session Handling

**Current (Electron):** Game state is stored in the SQLite database on disk. No session management needed — each game has a unique `game_id`.

**Cloudflare Workers:** Each request is stateless. The D1 database provides persistence, but in-memory caching between requests is not available.

**Considerations:**
- All game state must be read from/written to D1 on each API call (current design already does this)
- No server-side sessions needed — the `playerId` and `gameId` are passed as parameters in each request
- Rate limiting may be needed at the Worker level to prevent abuse (consider Cloudflare Rate Limiting rules)
- The `record-spin` handler currently updates player stats synchronously after each spin. In D1, this becomes a batch operation that must be wrapped in `db.batch()` for atomicity

### 2.12 Development Experience

**Electron development (unchanged):**
```bash
npm run dev        # electron-vite dev — hot reload for all three targets
npm run build      # electron-vite build
```

**Cloudflare Worker development (new):**
```bash
npm run dev:worker   # wrangler dev — local Worker emulation with D1
npm run build:worker # vite build --config vite.config.worker.ts
```

**Local D1 emulation:** Use `wrangler`'s built-in D1 emulation (SQLite file on disk) during development. In production, use a real Cloudflare D1 database.

**`wrangler.toml` configuration:**
```toml
name = "hadoken-high-roller"
main = "dist/worker/index.js"
compatibility_date = "2024-01-01"

[dev]
port = 8787

[[d1_databases]]
binding = "DB"
database_name = "hadoken-high-roller-dev"
database_id = "local-d1-db-id"
migrations_dir = "src/lib/database/migrations"

[assets]
directory = "dist/renderer"  # Serve built React app as static assets
```

### 2.13 TypeScript Configuration

New tsconfig needed for the Worker build:

```json
{
  "extends": "./tsconfig.node.json",
  "include": ["src/worker/**/*", "src/lib/**/*"],
  "compilerOptions": {
    "composite": true,
    "types": ["@cloudflare/workers-types"],
    "outDir": "./dist/worker",
    "moduleResolution": "bundler",
    "target": "ESNext"
  }
}
```

Add `@cloudflare/workers-types` as a dev dependency for D1 type definitions.

**Also update `tsconfig.web.json`:** Add `"src/lib/**/*"` to the `include` array so the renderer can resolve shared types and the API bridge.

### 2.14 Deployment Strategy

**Electron deployment (unchanged):**
```bash
npm run build:win   # Windows installer
npm run build:mac   # macOS DMG
npm run build:linux # Linux AppImage/DEB
```

**Cloudflare Worker deployment:**
```bash
npm run build:worker   # Build the Worker bundle + renderer assets
wrangler deploy         # Deploy to Cloudflare Workers
```

**Two deployment options for the full web app:**

1. **Single Worker with assets** — Serve the React SPA from the same Worker using Cloudflare Workers Assets (new feature). The Worker handles both API routes and serves static HTML/JS/CSS.

2. **Pages + Workers** — Deploy the React renderer to Cloudflare Pages (static hosting) and the Worker API separately. This requires CORS configuration but gives independent deployment of frontend and backend.

**Recommendation:** Option 1 (Workers Assets) is simpler for a single-team deployment. Use `wrangler.toml` `[assets]` configuration to serve the built renderer from the Worker.

### 2.15 Module System Differences (CommonJS vs ES Modules)

**Critical consideration:** The Electron main process and preload scripts use CommonJS (`require()` / `module.exports`), while Cloudflare Workers require ES Modules (`import` / `export`).

**Impact:**
- The Worker entry point and all shared code must use ES module syntax
- The Electron main process can remain CommonJS (or be converted to ESM if desired)
- Shared code in `src/lib/` must use ES module syntax since it will be imported by the Worker
- The Electron adapter (`src/main/database-adapter-electron.ts`) will need to import from the shared ES module code

**Resolution:**
- Use ES modules for all `src/lib/` files (both targets can import them)
- Keep Electron main/preload as CommonJS if preferred, or convert to ESM for consistency
- The `electron.vite.config.ts` already handles bundling, so module format differences are resolved at build time

### 2.16 Path Resolution Differences (`path.join` vs URL-based paths)

**Current code uses Node.js `path.join()` for database file location:**
```typescript
import { join } from 'path'
const dbPath = join(userDataPath, 'slotmachine.db')
```

**Impact:** The `path` module is not available in Cloudflare Workers. However, since the database logic is abstracted behind adapters:
- The Electron adapter can continue using `path.join` (runs in Node.js main process)
- The D1 adapter does not use file paths at all (D1 is a managed service)
- No changes needed to shared code for path handling

### 2.17 Type/Schema Mismatch (Existing Bug)

**Current issue:** The `Player` interface in `src/preload/index.d.ts` includes a `balance: number` field, but the actual SQLite `players` table has no `balance` column. The balance is computed dynamically from games/spins.

**This must be fixed as part of the migration:**
- Either add a `balance` column to the D1 schema and maintain it on every spin (adds complexity)
- Or remove `balance` from the shared type and compute it client-side or via a dedicated query
- The D1 adapter should return the correct shape that matches what the renderer actually expects

### 2.18 Electron App Lifecycle vs Worker Request Lifecycle

**Current code relies on Electron app lifecycle hooks:**
- `app.whenReady()` triggers `initDatabase()` and `setupIpcHandlers()` before the window is created
- `before-quit` triggers `closeDatabase()` for clean shutdown

**Cloudflare Workers have no equivalent lifecycle hooks.** Each request is independent and stateless.

**Impact on architecture:**
- Database initialization must happen per-request in the Worker (D1 connections are cheap and managed by Cloudflare)
- No cleanup/shutdown logic needed in the Worker (no `closeDatabase()` equivalent)
- The adapter pattern naturally handles this: each call to the D1 adapter opens a connection via `env.DB`, executes, and returns

### 2.19 Shared Type Safety Across Targets

**Current state:** Types are defined in `src/preload/index.d.ts` and imported by the main process. The renderer gets types via the preload's `contextBridge` exposure.

**Required changes:**
1. Move all shared types (`Player`, `LeaderboardEntry`, `AppAPI`) to `src/lib/types/api.ts`
2. Have the preload script re-export from shared types: `export type { Player, LeaderboardEntry } from '../../lib/types/api'`
3. Have the main process import from shared types instead of preload types
4. The Worker imports the same shared types
5. Update `tsconfig.web.json` to include `"src/lib/**/*"` in its `include` path

This ensures all three targets (Electron main, Electron renderer, Cloudflare Worker) use identical type definitions.

### 2.20 `tsconfig.node.json` Must Include Shared Types

**Current state:** `tsconfig.node.json` includes `"src/main/**/*"` and `"src/preload/**/*"`. The main process imports types from `src/preload/index.d.ts` (e.g., `Player`, `LeaderboardEntry`).

**Gap:** After moving types to `src/lib/types/api.ts`, the node config must also include `"src/lib/**/*"` in its `include` path, otherwise the main process will fail to resolve shared types.

**Fix:** Update `tsconfig.node.json`:
```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.node.json",
  "include": ["electron.vite.config.*", "src/main/**/*", "src/preload/**/*", "src/lib/**/*"],
  "compilerOptions": { ... }
}
```

### 2.21 Renderer Dual-Build Strategy

**Current state:** `electron-vite` produces a single renderer build that is loaded by the Electron BrowserWindow.

**Gap:** For Cloudflare Workers Assets, the same renderer source must be built as a standalone static site (producing `dist/renderer/`) that can be served by the Worker. The plan says the renderer is "shared" but doesn't explain how one source tree produces two different builds.

**Fix:** Add a second Vite config (`vite.config.renderer.ts`) for standalone web builds:
```typescript
// vite.config.renderer.ts — used by both electron-vite and standalone web builds
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@renderer': '/src' }
  },
  build: {
    outDir: 'dist/renderer',
    sourcemap: true
  }
})
```

The `electron.vite.config.ts` renderer config should reference this shared config. The standalone web build runs via `vite build --config vite.config.renderer.ts` before the Worker build bundles it as assets.

### 2.22 CSP Meta Tag in `index.html`

**Current state:** `src/renderer/index.html` contains:
```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />
```

**Gap:** When the renderer is served from a Cloudflare Worker, this CSP restricts `script-src` to `'self'`. If the Worker API (`/api/*`) is on a different subdomain or origin, fetch calls may be blocked. Additionally, `'unsafe-inline'` for styles is a security concern and should be audited.

**Fix:** 
- For the web build, either remove the CSP meta tag entirely (rely on HTTP headers set by the Worker) or update it to allow fetch to the API origin
- Consider using a build-time conditional: `vite.config.renderer.ts` can use `htmlTransform` to strip or modify the CSP meta tag for web builds
- Audit all inline styles in components — if none exist, replace `'unsafe-inline'` with a proper nonce or hash-based CSP

### 2.23 `better-sqlite3` as Production Dependency

**Current state:** `better-sqlite3` is listed in `dependencies` (not `devDependencies`) in `package.json`.

**Gap:** Even with Vite's `external` configuration, the web build may attempt to resolve `better-sqlite3` during dependency analysis and fail (it is a native Node.js module). The web build will crash at bundle time.

**Fix:** Move `better-sqlite3` (and `electron-store`, which is unused) from `dependencies` to `optionalDependencies`. This way:
- Electron builds install and use them normally
- Web/Worker builds skip them silently without resolution errors
- `npm install` on a machine without Cloudflare Workers still works

### 2.24 `tsconfig.worker.json` Must Not Inherit Electron Types

**Current state:** The plan specifies `tsconfig.worker.json` extends `tsconfig.node.json`.

**Gap:** `tsconfig.node.json` includes `"types": ["electron-vite/node"]`, which pulls in Electron type definitions. These will be available in the Worker build, causing false positives (code that uses `ipcMain`, `BrowserWindow`, etc. will type-check but fail at runtime).

**Fix:** Override the `types` field in `tsconfig.worker.json`:
```json
{
  "extends": "./tsconfig.node.json",
  "include": ["src/worker/**/*", "src/lib/**/*"],
  "compilerOptions": {
    "composite": true,
    "types": ["@cloudflare/workers-types"],  // Overrides electron-vite/node from parent
    "outDir": "./dist/worker",
    "moduleResolution": "bundler",
    "target": "ESNext"
  }
}
```

### 2.25 Error Handling in API Bridge

**Current state:** The plan shows the happy path for the unified API bridge but does not address error serialization.

**Gap:** IPC errors and HTTP errors have fundamentally different shapes:
- IPC errors are serialized as plain objects (losing `Error` prototype, stack traces)
- HTTP errors require parsing the response body and status code

The bridge must normalize both into a consistent error format that renderer components can handle uniformly.

**Fix:** Define a normalized error type and implement conversion in the bridge:
```typescript
// src/lib/types/api.ts
interface ApiError {
  message: string;
  code?: string;
}

// src/lib/api-bridge.ts
class ApiBridge {
  private normalizeError(error: unknown): ApiError {
    if (error instanceof Error) return { message: error.message }
    if (typeof error === 'object' && error !== null && 'message' in error) {
      return { message: String(error.message) }
    }
    return { message: 'Unknown error occurred' }
  }

  async getOrCreatePlayer(name: string): Promise<Player> {
    if (this.isCloudflare) {
      const res = await fetch('/api/player/create', { method: 'POST', body: JSON.stringify({ name }) })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw this.normalizeError(err)
      }
      return res.json()
    }
    try {
      return await window.api.getOrCreatePlayer(name)
    } catch (error) {
      throw this.normalizeError(error)
    }
  }
}
```

### 2.26 `slotmachine.db` in Repository Root

**Current state:** A SQLite database file (`slotmachine.db`) exists at the project root. It is not in `.gitignore`.

**Gap:** This file should not be committed to version control. It is a test artifact from running the Electron app locally and contains no meaningful data (just the default "Player 1" row).

**Fix:** Add `*.db` and specifically `slotmachine.db*` (including WAL and SHM files) to `.gitignore`:
```
# Database files
*.db
*.db-wal
*.db-shm
slotmachine.db*
```

### 2.27 D1 Migration Workflow Commands

**Current state:** The plan mentions creating migration files in `src/lib/database/migrations/` but does not specify the wrangler commands to create and apply them.

**Gap:** Developers need clear instructions for the full D1 setup workflow, not just the file structure.

**Fix:** Add these commands to Section 8 (Development Workflow):
```bash
# Create the D1 database in your Cloudflare account
wrangler d1 create hadoken-high-roller

# Create a migration file (generates a timestamped SQL file)
wrangler d1 migrations create hadoken-high-roller initial-schema

# Apply migrations locally (for development)
wrangler d1 migrations apply hadoken-high-roller --local

# Apply migrations to production
wrangler d1 migrations apply hadoken-high-roller --remote

# Execute ad-hoc SQL queries for debugging
wrangler d1 execute hadoken-high-roller --command "SELECT * FROM players"
```

### 2.28 `electron-builder.yml` ASAR + Native Modules

**Current state:** `electron-builder.yml` has `asarUnpack: ["resources/**"]` but does not list `better-sqlite3`.

**Gap:** Electron-builder packages the app into an ASAR archive by default. Native modules like `better-sqlite3` cannot be loaded from within an ASAR archive — they must be unpacked to the filesystem. Without explicit `asarUnpack` for `better-sqlite3`, the Electron app will crash at startup with a module loading error.

**Fix:** Add `better-sqlite3` to the `asarUnpack` list in `electron-builder.yml`:
```yaml
appId: com.electron.app
productName: Hadoken High Roller
# ... existing config ...
asarUnpack:
  - "resources/**"
  - "node_modules/better-sqlite3/**"
```

### 2.29 `@electron-toolkit/preload` Import in Preload Script

**Current state:** `src/preload/index.ts` imports `electronAPI` from `@electron-toolkit/preload`:
```typescript
import { electronAPI } from '@electron-toolkit/preload'
```

**Gap:** If the web build accidentally references or bundles preload files (e.g., through a misconfigured Vite alias), this import will fail because `@electron-tool-cookie/preload` is Electron-only. The plan's conditional loading in Section 2.7 is not sufficient — the import itself must be guarded or removed from any web build path.

**Fix:** 
- Ensure `electron.vite.config.ts` does not include preload files in the renderer build entry
- Add a runtime guard in `src/preload/index.ts`:
  ```typescript
  // Guard against web build accidentally bundling this file
  if (typeof process === 'undefined' || !process.versions?.electron) {
    // No-op in web builds — window.api will be set by ApiBridge instead
  } else {
    // Electron-specific initialization
    import { electronAPI } from '@electron-toolkit/preload'
    // ... rest of preload logic
  }
  ```
- Alternatively, move the `@electron-toolkit/preload` import to a separate Electron-only module and have preload conditionally import it.

### 2.30 `window.electron` Global Exposure and Detection Reliability

**Current state:** The preload script exposes `window.electron = electronAPI` via `contextBridge`. The API bridge's `isElectron()` check (Section 7.4) relies on detecting this global.

**Gap:** The detection `process.versions?.electron != null` is the primary guard, but it could produce false positives if:
- A browser extension or third-party script sets `process.versions.electron`
- The code runs in a Node.js context that is not Electron (e.g., during SSR testing)
- `navigator.userAgent` contains the string "Electron" from a spoofed user agent

**Fix:** Use a multi-factor detection approach that requires all signals to agree:
```typescript
function isElectron(): boolean {
  // All three conditions must be true for reliable detection
  const hasElectronProcess = typeof process !== 'undefined' && 
    process.versions?.electron != null && 
    process.versions?.node != null  // Node.js is always present in Electron
  const hasElectronUserAgent = typeof navigator !== 'undefined' && 
    navigator.userAgent?.includes('Electron')
  const hasContextBridge = typeof window !== 'undefined' && 
    (window as any).electron != null
  
  return hasElectronProcess && hasElectronUserAgent
}
```

The `hasContextBridge` check is intentionally excluded from the primary detection — it can be used as a secondary confirmation if needed, but should not be required since the preload script may not have run yet at detection time.

---

## 3. Implementation Phases

### Phase 1: Shared Types and Database Abstraction Layer
- [ ] Create `src/lib/types/api.ts` with shared interfaces (`Player`, `LeaderboardEntry`, `AppAPI`)
- [ ] Create `src/lib/database/adapter.ts` with the unified database interface
- [ ] Extract existing SQL schema from `src/main/database.ts` into `src/lib/database/schema.sql`
- [ ] Create D1 migration files in `src/lib/database/migrations/`
- [ ] Implement Electron adapter (`src/main/database-adapter-electron.ts`) wrapping existing `better-sqlite3` logic
- [ ] Implement D1 adapter (`src/lib/database/adapter-d1.ts`) using Cloudflare D1 API
- [ ] Update `src/preload/index.d.ts` to re-export from shared types
- [ ] Update `tsconfig.web.json` to include `"src/lib/**/*"` in its `include` path
- [ ] Update `tsconfig.node.json` to include `"src/lib/**/*"` in its `include` path (Section 2.20)

### Phase 2: Refactor Electron Main Process
- [ ] Extract IPC handlers from `src/main/database.ts` into the new adapter pattern
- [ ] Simplify `src/main/database.ts` to only handle Electron-specific concerns (init, close, singleton)
- [ ] Wire the adapter into `setupIpcHandlers()` in `src/main/index.ts`
- [ ] Add `better-sqlite3` to `asarUnpack` in `electron-builder.yml` (Section 2.28)
- [ ] Run `npm run dev` to verify Electron build still works after refactoring

### Phase 3: Cloudflare Worker API
- [ ] Create `src/worker/index.ts` entry point with route handlers
- [ ] Implement all 5 API endpoints (`/api/player/create`, `/api/game/start`, `/api/spin/record`, `/api/game/end`, `/api/leaderboard`)
- [ ] Create `wrangler.toml` configuration with D1 binding and assets config
- [ ] Add `@cloudflare/workers-types` dev dependency
- [ ] Set up local D1 development environment with `wrangler dev`
- [ ] Document D1 migration commands (`wrangler d1 create`, `migrations apply`) (Section 2.27)

### Phase 4: Unified API Bridge for Renderer
- [ ] Create `src/lib/api-bridge.ts` with runtime detection and dual transport (IPC vs fetch)
- [ ] Implement normalized error handling (`ApiError` type, `normalizeError()` method) (Section 2.25)
- [ ] Update renderer components to use the unified API bridge via `window.api`
- [ ] Handle environment detection in `src/renderer/src/main.tsx` or a dedicated init module
- [ ] Ensure `window.api` type is correctly resolved in both Electron and web builds

### Phase 5: Build System
- [ ] Create `vite.config.worker.ts` for Worker build (ESM output, externalize deps)
- [ ] Create `vite.config.renderer.ts` for standalone web renderer build (Section 2.21)
- [ ] Create `tsconfig.worker.json` with Cloudflare types, overriding parent's Electron types (Section 2.24)
- [ ] Add `build:worker` and `dev:worker` scripts to `package.json`
- [ ] Move `better-sqlite3` and `electron-store` to `optionalDependencies` (Section 2.23)
- [ ] Configure Worker build to bundle renderer assets (Workers Assets) or set up Pages deployment

### Phase 6: Renderer Compatibility
- [ ] Conditionally include Electron preload in Electron build only (verify `electron-vite` config handles this)
- [ ] Guard preload script against web build bundling (`@electron-toolkit/preload` import) (Section 2.29)
- [ ] Consider switching from `MemoryRouter` to `HashRouter` in `App.tsx` for better Worker compatibility
- [ ] Test Three.js + Vanta in Worker environment; add polyfills or fallback if needed
- [ ] Add CORS middleware to Worker responses
- [ ] Fix the `Player.balance` type/schema mismatch (Section 2.17)
- [ ] Update or conditionally strip CSP meta tag in `index.html` for web builds (Section 2.22)

### Phase 7: Testing & Validation
- [ ] Verify Electron build still works (`npm run dev`, `npm run build`)
- [ ] Verify Worker local development (`npm run dev:worker`)
- [ ] Test all 5 API endpoints against local D1 via `wrangler`
- [ ] Deploy to Cloudflare and verify production behavior
- [ ] Cross-test: ensure data models are compatible between Electron SQLite and D1
- [ ] Verify typecheck passes for all targets (`npm run typecheck` + worker-specific check)
- [ ] Verify `better-sqlite3` is properly unpacked from ASAR in Electron build (Section 2.28)
- [ ] Verify CSP does not block API fetch calls in web build (Section 2.22)

### Phase 8: Documentation & Polish
- [ ] Update README with dual-build instructions
- [ ] Document D1 migration process for new environments (Section 2.27)
- [ ] Add `.env.example` with required Cloudflare configuration
- [ ] Document deployment steps for both targets
- [ ] Add `*.db` and `slotmachine.db*` to `.gitignore` (Section 2.26)

---

## 4. File Structure After Implementation

```
hadoken-high-roller/
├── docs/
│   └── cloudflare-worker-plan-opencode-complete.md  # This document
├── src/
│   ├── lib/                                  # Shared code (both targets)
│   │   ├── database/
│   │   │   ├── adapter.ts                    # DB interface definition
│   │   │   ├── adapter-d1.ts                 # D1 adapter implementation
│   │   │   ├── schema.sql                    # D1 migration SQL
│   │   │   └── migrations/                   # wrangler migration files
│   │   ├── api-bridge.ts                     # Unified API bridge for renderer (with error handling)
│   │   └── types/
│   │       └── api.ts                        # Shared TypeScript types (Player, etc.)
│   ├── main/                                 # Electron-only (main process)
│   │   ├── index.ts                          # Entry point (minimal changes)
│   │   └── database-adapter-electron.ts      # Electron DB adapter (extracted)
│   ├── preload/                              # Electron-only (preload script)
│   │   ├── index.ts                          # IPC bridge (guarded against web build)
│   │   └── index.d.ts                        # Re-exports from shared types
│   ├── worker/                               # Cloudflare Worker (NEW)
│   │   ├── index.ts                          # Entry point + route handlers
│   │   └── routes/                           # API route modules (optional split)
│   └── renderer/                             # Shared (React UI - minimal changes)
│       ├── index.html                        # CSP meta tag stripped for web builds
│       └── src/
├── electron.vite.config.ts                   # Unchanged (Electron build)
├── vite.config.worker.ts                     # NEW - Worker build config
├── vite.config.renderer.ts                   # NEW - Standalone web renderer build
├── tsconfig.node.json                        # Updated: includes src/lib/**/*
├── tsconfig.web.json                         # Updated: includes src/lib/**/*
├── tsconfig.worker.json                      # NEW - Worker TS config (overrides Electron types)
├── wrangler.toml                             # NEW - Cloudflare configuration
├── electron-builder.yml                      # Updated: asarUnpack for better-sqlite3
├── .gitignore                                # Updated: *.db, slotmachine.db*
└── package.json                              # New scripts + dev deps; native deps -> optionalDependencies
```

---

## 5. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Three.js / Vanta not compatible with Workers runtime | Renderer may crash on web build | Test early; add `Worker` polyfill or fallback to CSS-based background animation |
| D1 query performance differences from local SQLite | Slower spin recording / leaderboard loads | Use `db.batch()` for multi-statement operations; add query caching if needed |
| Bundle size limits on Workers (5 MB free tier) | Large asset bundles may exceed limits | Monitor bundle size; move assets to R2/CDN if needed |
| Breaking changes in Electron build during refactoring | Existing desktop users affected | Keep Electron adapter isolated; run `npm run dev` after each phase to verify |
| D1 not available in local development without wrangler | Developer friction | Document `wrangler` setup clearly; use SQLite file emulation via `wrangler d1 execute` |
| Module system mismatch (CJS vs ESM) between Electron main and shared code | Build errors or runtime failures | Use ES modules for all `src/lib/` files; Vite handles CJS/ESM interop at build time |
| `Player.balance` type/schema mismatch not fixed | Runtime errors in renderer when accessing `player.balance` | Fix during Phase 1 as part of shared type creation |
| Path module usage in shared code | Build failures for Worker target | Ensure all `path` usage stays in Electron-specific adapter only |
| `better-sqlite3` not unpacked from ASAR | Electron app crashes at startup with module loading error | Add `better-sqlite3` to `asarUnpack` in `electron-builder.yml` (Section 2.28) |
| CSP meta tag blocks API fetch calls in web build | Worker API calls fail with CORS/SecurityError | Strip or update CSP meta tag for web builds (Section 2.22) |
| `@electron-toolkit/preload` import fails in web build | Web bundle fails to compile or crashes at runtime | Guard preload script with Electron runtime check (Section 2.29) |
| `tsconfig.worker.json` inherits Electron types from parent | False positives in type checking; runtime errors from using Electron APIs | Override `types` field to only include `@cloudflare/workers-types` (Section 2.24) |
| `slotmachine.db*` committed to git history | Bloated repo; exposes local test data | Add `*.db`, `slotmachine.db*` to `.gitignore`; consider git filter-branch if already committed |

---

## 6. Summary of Changes by Category

### New Files
| File | Purpose |
|---|---|
| `src/lib/types/api.ts` | Shared TypeScript types (Player, LeaderboardEntry, AppAPI) |
| `src/lib/database/adapter.ts` | Database interface definition |
| `src/lib/database/adapter-d1.ts` | D1 adapter implementation |
| `src/lib/database/schema.sql` | D1 migration SQL |
| `src/lib/api-bridge.ts` | Unified API bridge for renderer (with normalized error handling) |
| `src/worker/index.ts` | Cloudflare Worker entry point + routes |
| `vite.config.worker.ts` | Worker Vite configuration |
| `vite.config.renderer.ts` | Standalone web renderer build config (CSP stripping, output to `dist/renderer/`) |
| `tsconfig.worker.json` | Worker TypeScript config (overrides Electron types from parent) |
| `wrangler.toml` | Cloudflare Workers configuration |

### Modified Files
| File | Change |
|---|---|
| `src/main/database.ts` | Extracted IPC handlers to adapter pattern; simplified to Electron-specific concerns |
| `src/main/index.ts` | Wires in the new adapter instead of inline database logic |
| `src/preload/index.ts` | Guarded with Electron runtime check to prevent web build bundling; re-exports from shared types |
| `src/preload/index.d.ts` | Re-exports from shared types instead of defining them inline |
| `src/renderer/src/App.tsx` | Router change (MemoryRouter -> HashRouter) for web compatibility |
| `src/renderer/src/main.tsx` | API bridge initialization based on runtime detection |
| `src/renderer/index.html` | CSP meta tag stripped or modified for web builds (Section 2.22) |
| `package.json` | New scripts (`build:worker`, `dev:worker`) and dev dependencies; native deps moved to `optionalDependencies` |
| `tsconfig.web.json` | Add `"src/lib/**/*"` to `include` path for shared types |
| `tsconfig.node.json` | Add `"src/lib/**/*"` to `include` path for shared types (Section 2.20) |
| `tsconfig.worker.json` | NEW — Worker TS config, overrides parent's Electron types (Section 2.24) |
| `electron-builder.yml` | Add `better-sqlite3` to `asarUnpack` (Section 2.28) |
| `.gitignore` | Add `*.db`, `*.db-wal`, `*.db-shm`, `slotmachine.db*` (Section 2.26) |

### Unchanged Files
| Category | Examples |
|---|---|
| Renderer components | `src/renderer/src/components/*` — use `window.api` which is abstracted |
| Electron build config | `electron.vite.config.ts` — Electron build untouched (but renderer sub-config may reference shared config) |
| Desktop packaging structure | `electron-builder.yml` — unchanged structure, but must add `asarUnpack` for `better-sqlite3` |
| Asset files | Images, sounds — bundled in both builds |

---

## 7.1 Additional Build Config Changes Required

### `electron-builder.yml` — ASAR Unpack for Native Modules
```yaml
# Add better-sqlite3 to asarUnpack so Electron can load the native module
asarUnpack:
  - "resources/**"
  - "node_modules/better-sqlite3/**"
```

### `package.json` — Move Native Dependencies to Optional
```json
{
  "optionalDependencies": {
    "better-sqlite3": "^11.9.1",
    "electron-store": "^10.0.1"
  },
  "dependencies": {
    // Remove better-sqlite3 and electron-store from here
    "react-router-dom": "^7.10.1",
    "three": "0.134.0",
    "vanta": "0.5.24"
  }
}
```

### `.gitignore` — Exclude Database Artifacts
```
# SQLite database files (local test artifacts)
*.db
*.db-wal
*.db-shm
slotmachine.db*
```

### `src/preload/index.ts` — Guard Against Web Build Bundling
```typescript
// Guard: if not in Electron, skip all preload logic entirely
if (typeof process === 'undefined' || !process.versions?.electron) {
  // Web build — do nothing; window.api will be set by ApiBridge
} else {
  // Electron-only code below
  import { contextBridge, ipcRenderer } from 'electron'
  import { electronAPI } from '@electron-toolkit/preload'

  const api = { /* ... */ }

  if (process.contextIsolated) {
    try {
      contextBridge.exposeInMainWorld('electron', electronAPI)
      contextBridge.exposeInMainWorld('api', api)
    } catch (error) {
      console.error(error)
    }
  } else {
    // @ts-ignore (define in dts)
    window.electron = electronAPI
    // @ts-ignore (define in dts)
    window.api = api
  }
}
```

### `src/renderer/index.html` — CSP for Web Builds
For the standalone web build, either:
- Remove the CSP meta tag entirely and rely on HTTP headers set by the Worker
- Or use a Vite `htmlTransform` to conditionally strip/modify it:
  ```typescript
  // vite.config.renderer.ts
  export default defineConfig({
    plugins: [{
      name: 'strip-csp',
      transformIndexHtml(html) {
        return html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/g, '')
      }
    }]
  })
  ```

---

## 7. Detailed Code Migration Notes

### 7.1 `record-spin` Handler Complexity

The current `record-spin` IPC handler (lines 168-257 of `src/main/database.ts`) performs a multi-step operation:

1. Validate inputs
2. Verify game exists
3. Insert spin record into `spins` table
4. Calculate current balance via JOIN query on `games` + `spins`
5. Update player stats (`total_spins`, `highest_balance`)

**In the Electron adapter**, this remains largely unchanged since `better-sqlite3` supports synchronous multi-step operations.

**In the D1 adapter**, steps 3-5 must be wrapped in `db.batch()` for atomicity, since D1 does not support transactions. The batch API accepts an array of prepared statements and returns results for each:

```typescript
// D1 adapter pattern for record-spin
const batchResults = await env.DB.batch([
  db.prepare('INSERT INTO spins ...').bind(gameId, symbols, betAmount, winAmount),
  db.prepare('UPDATE players SET ...').bind(currentBalance, currentBalance, playerId)
])
```

Note: The balance calculation (step 4) requires a `SELECT` before the `UPDATE`, so it cannot be fully batched. It must remain a separate query, but both the INSERT and UPDATE can be batched together for atomicity.

### 7.2 `getOrCreatePlayer` Upsert Logic

The current implementation does a SELECT followed by an INSERT if not found. This has a race condition in concurrent environments (two requests could both see "not found" and both try to INSERT).

**In the Electron adapter**, this is fine since `better-sqlite3` is single-threaded and synchronous.

**In the D1 adapter**, add a `UNIQUE` constraint on `players.name` and use `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` to handle the race condition safely:

```sql
INSERT INTO players (name) VALUES (?) ON CONFLICT(name) DO NOTHING;
-- Then SELECT the player by name (will find either the newly inserted or existing row)
```

### 7.3 Vite Configuration for Worker Build

The `vite.config.worker.ts` must handle several important settings:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/worker/index.ts',
      formats: ['es'],
      fileName: () => 'worker/index.js'
    },
    rollupOptions: {
      external: [
        // Do NOT bundle Electron dependencies
        'electron',
        '@electron-toolkit/preload',
        '@electron-toolkit/utils',
        'better-sqlite3'
      ]
    },
    sourcemap: true,
    minify: true
  }
})
```

The renderer build for the Worker target should use a separate Vite config or a multi-entry approach to produce `dist/renderer/` for the Workers Assets feature.

### 7.4 Environment Detection Code

The API bridge needs reliable runtime detection:

```typescript
function isElectron(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof process !== 'undefined' &&
    process.versions?.electron != null &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent?.includes('Electron')
  )
}

function isCloudflare(): boolean {
  return (
    typeof window !== 'undefined' &&
    !isElectron() &&
    // Cloudflare Workers expose a global `caches` API and lack Node globals
    typeof process === 'undefined' ||
    (typeof process !== 'undefined' && !process.versions?.electron)
  )
}
```

The detection should be cached after the first call to avoid repeated checks.

---

## 8. Development Workflow After Implementation

### Developing the Electron App (unchanged)
```bash
npm run dev              # Start Electron app with HMR
npm run build            # Build for production (Electron)
npm run build:mac        # Build macOS DMG
npm run build:win        # Build Windows installer
```

### Developing the Cloudflare Worker (new)
```bash
npm run dev:worker       # Start local Worker with D1 emulation (wrangler)
npm run build:worker     # Build Worker bundle + renderer assets
wrangler deploy          # Deploy to Cloudflare Workers
```

### D1 Database Setup Commands (run once per environment)
```bash
# Create the D1 database in your Cloudflare account
wrangler d1 create hadoken-high-roller

# Create a migration file (generates a timestamped SQL file in migrations/)
wrangler d1 migrations create hadoken-high-roller initial-schema

# Apply migrations locally (for development)
wrangler d1 migrations apply hadoken-high-roller --local

# Apply migrations to production
wrangler d1 migrations apply hadoken-high-roller --remote

# Execute ad-hoc SQL queries for debugging
wrangler d1 execute hadoken-high-roller --command "SELECT * FROM players"
```

### Running Both Simultaneously

Both builds can run at the same time without conflicts since they use different output directories (`out/` for Electron, `dist/` for Worker) and different ports (Electron uses its own Chromium instance; Worker uses port 8787 by default).
