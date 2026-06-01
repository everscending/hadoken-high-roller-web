# Cloudflare Worker Deployment Plan

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

---

## 2. Key Considerations

### 2.1 Runtime Environment Differences

| Concern | Electron (Main Process) | Cloudflare Worker |
|---|---|---|
| Runtime | Node.js (full) | V8 isolate (limited) |
| File System Access | ✅ `fs`, `path.join` | ❌ Not available |
| Native Modules | ✅ `better-sqlite3` | ❌ Not supported |
| IPC Mechanism | `ipcMain` / `ipcRenderer` | HTTP REST API (fetch) |
| Persistence | SQLite file on disk | Cloudflare D1 (SQLite-compatible API) |
| Environment Variables | `process.env` | `env.*` bindings |
| Lifecycle Hooks | `app.whenReady()`, `before-quit` | Request/response lifecycle only |
| Concurrency | Single-threaded (Node event loop) | Per-request isolation, auto-scaled |

**Implication:** The data access layer must be abstracted behind a unified interface so the renderer can call `api.getOrCreatePlayer()` regardless of which runtime it's in.

---

### 2.2 Database Abstraction Layer (Critical)

This is the most significant architectural change. The current code couples `better-sqlite3` directly to IPC handlers in the main process. We need a **database adapter pattern**:

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
│                    │  D1 via @miniflare/ │     │
│                    │  or cloudflare:db   │     │
│                    └─────────────────────┘     │
└───────────────────────────────────────────────┘
```

**Required interface methods:**
- `getOrCreatePlayer(name: string): Promise<Player>`
- `startGame(playerId: number, startingBalance: number): Promise<{ gameId: number }>`
- `recordSpin(gameId: number, symbols: string, betAmount: number, winAmount: number): Promise<{ spinId: number }>`
- `endGame(gameId: number, endingBalance: number): Promise<void>`
- `getLeaderboard(): Promise<LeaderboardEntry[]>`

**Implementation approach:**
1. Create a shared `src/lib/database/adapter.ts` defining the interface
2. Implement `src/main/database-adapter-electron.ts` wrapping existing `better-sqlite3` logic
3. Implement `src/lib/database-adapter-d1.ts` using D1's prepared statement API
4. The Electron main process uses the Electron adapter; the Cloudflare Worker uses the D1 adapter

---

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

---

### 2.4 Build System Changes

The current build uses `electron-vite` which bundles three targets: main, preload, renderer. We need to add a fourth target for Cloudflare Workers.

**Proposed structure:**
```
src/
├── lib/                    # Shared code (both targets)
│   ├── database/
│   │   ├── adapter.ts      # DB interface definition
│   │   └── schema.sql      # D1 migration SQL (shared)
│   ├── api-bridge.ts       # Unified API bridge for renderer
│   └── types/              # Shared TypeScript types
├── main/                   # Electron-only (main process)
│   ├── index.ts
│   └── database-adapter-electron.ts
├── preload/                # Electron-only (preload script)
│   └── index.ts
├── worker/                 # Cloudflare Worker (new)
│   ├── index.ts            # Entry point
│   └── routes/             # API route handlers
└── renderer/               # Shared (React UI)
    └── src/
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

---

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

---

### 2.6 Electron-Specific Dependencies

These dependencies are **Electron-only** and must not be bundled into the Cloudflare Worker build:

| Dependency | Used In | Cloudflare Compatible? |
|---|---|---|
| `better-sqlite3` | Main process (database) | ❌ Native module, not supported |
| `electron-store` | Main process (state) | ❌ File system dependent |
| `@electron-toolkit/preload` | Preload script | ❌ Electron-only |
| `@electron-toolkit/utils` | Main process | ❌ Electron-only |
| `electron`, `electron-builder` | Build tooling | ❌ Not needed for Worker |

**Resolution:**
- These are already handled by `externalizeDepsPlugin` in the Electron build
- The Worker build must explicitly exclude them via Vite's `noExternal` / `optimizeDeps` configuration
- The shared code paths must not import any Electron-specific modules

---

### 2.7 Renderer Environment Detection & Conditional Loading

The renderer currently assumes `window.api` is always available via the Electron preload script. For Cloudflare deployment:

**Changes needed in renderer:**

1. **Remove Electron-specific preload injection** — The preload script (`src/preload/index.ts`) must be conditionally included only in the Electron build.

2. **API bridge initialization** — The renderer must initialize its API bridge based on the runtime:
   ```typescript
   // In main.tsx or a dedicated init module
   if (typeof window !== 'undefined' && !window.electron) {
     // Cloudflare / web environment — use fetch-based API bridge
     window.api = new ApiBridge()
   }
   // Electron environment — preload script already sets window.api via IPC
   ```

3. **Type declarations** — Update `src/preload/index.d.ts` to be shared and not Electron-specific:
   - Move the `AppAPI` interface to `src/lib/types/api.ts` (shared)
   - Keep Electron-specific type augmentations in the preload module

---

### 2.8 Static Assets (Images, Sounds)

The renderer imports images and audio files via Vite's asset handling:
```typescript
import symbol1 from '../assets/symbols/balrog.png'
import youWonSoundUrl from '../assets/sounds/youwin.mp3?url'
```

**Consideration:** These assets are bundled by Vite in both builds. In the Cloudflare Worker build, they will be included in the Worker's bundled output (Workers support assets up to the bundle size limit). For very large asset collections, consider using Cloudflare R2 or a CDN.

**Current assets are small enough** (PNG icons, MP3 sounds) that bundling into the Worker is acceptable.

---

### 2.9 Third-Party Library Compatibility

| Library | Electron Compatible? | Cloudflare Worker Compatible? | Notes |
|---|---|---|---|
| `react` / `react-dom` | ✅ | ✅ | Standard web libraries |
| `react-router-dom` | ✅ | ✅ | MemoryRouter works in both; consider switching to HashRouter for SPA routing on Workers |
| `three` (0.134.0) | ✅ | ⚠️ Partially | Three.js uses Web Workers internally; may need `Worker` polyfill or bundling config for Cloudflare |
| `vanta` (0.5.24) | ✅ | ⚠️ Partially | Depends on Three.js; same concerns apply. Also uses `requestAnimationFrame` which works in Workers but may need attention |
| `@electron-toolkit/*` | ✅ | ❌ Electron-only | Must be excluded from Worker build |
| `better-sqlite3` | ✅ | ❌ Native module | Replaced by D1 adapter |
| `electron-store` | ✅ | ❌ File system | Not needed for Worker (D1 handles persistence) |

**Action items:**
- Test Three.js + Vanta in a Worker environment; if `Worker` constructor is unavailable, configure Vite to inline the Three.js web worker
- Consider using `HashRouter` instead of `MemoryRouter` for better compatibility with Cloudflare Workers (enables direct URL sharing and browser back/forward)

---

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

---

### 2.11 State Management & Session Handling

**Current (Electron):** Game state is stored in the SQLite database on disk. No session management needed — each game has a unique `game_id`.

**Cloudflare Workers:** Each request is stateless. The D1 database provides persistence, but in-memory caching between requests is not available.

**Considerations:**
- All game state must be read from/written to D1 on each API call (current design already does this)
- No server-side sessions needed — the `playerId` and `gameId` are passed as parameters in each request
- Rate limiting may be needed at the Worker level to prevent abuse (consider Cloudflare Rate Limiting rules)

---

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

---

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

---

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

---

## 3. Implementation Phases

### Phase 1: Database Abstraction Layer
- [ ] Create shared `src/lib/database/adapter.ts` with the unified interface
- [ ] Extract existing SQL schema from `src/main/database.ts` into `src/lib/database/schema.sql`
- [ ] Create D1 migration files in `src/lib/database/migrations/`
- [ ] Implement Electron adapter (`src/main/database-adapter-electron.ts`) wrapping existing logic
- [ ] Implement D1 adapter (`src/lib/database-adapter-d1.ts`) using Cloudflare D1 API
- [ ] Update Electron main process to use the new adapter pattern

### Phase 2: Cloudflare Worker API
- [ ] Create `src/worker/index.ts` entry point
- [ ] Implement route handlers for all 5 API endpoints
- [ ] Create `wrangler.toml` configuration
- [ ] Add `@cloudflare/workers-types` dev dependency
- [ ] Set up local D1 development environment with `wrangler dev`

### Phase 3: Unified API Bridge for Renderer
- [ ] Create `src/lib/api-bridge.ts` with runtime detection and dual transport
- [ ] Move `AppAPI`, `Player`, `LeaderboardEntry` types to shared location
- [ ] Update renderer components to use the unified API bridge
- [ ] Handle environment detection in `main.tsx`

### Phase 4: Build System
- [ ] Create `vite.config.worker.ts` for Worker build
- [ ] Create `tsconfig.worker.json`
- [ ] Add `build:worker` and `dev:worker` scripts to `package.json`
- [ ] Configure Worker build to bundle renderer assets (Workers Assets)

### Phase 5: Renderer Compatibility
- [ ] Conditionally include Electron preload in Electron build only
- [ ] Consider switching from `MemoryRouter` to `HashRouter` for better Worker compatibility
- [ ] Test Three.js + Vanta in Worker environment; add polyfills if needed
- [ ] Add CORS middleware to Worker responses

### Phase 6: Testing & Validation
- [ ] Verify Electron build still works (`npm run dev`, `npm run build`)
- [ ] Verify Worker local development (`npm run dev:worker`)
- [ ] Test all API endpoints against local D1
- [ ] Deploy to Cloudflare and verify production behavior
- [ ] Cross-test: ensure data models are compatible between Electron SQLite and D1

### Phase 7: Documentation & Polish
- [ ] Update README with dual-build instructions
- [ ] Document D1 migration process for new environments
- [ ] Add `.env.example` with required Cloudflare configuration
- [ ] Document deployment steps for both targets

---

## 4. File Structure After Implementation

```
hadoken-high-roller/
├── docs/
│   └── cloudflare-worker-plan.md          # This document
├── src/
│   ├── lib/                               # Shared code (both targets)
│   │   ├── database/
│   │   │   ├── adapter.ts                 # DB interface definition
│   │   │   ├── schema.sql                 # D1 migration SQL
│   │   │   └── migrations/                # wrangler migration files
│   │   ├── api-bridge.ts                  # Unified API bridge for renderer
│   │   └── types/                         # Shared TypeScript types
│   ├── main/                              # Electron-only (main process)
│   │   ├── index.ts                       # Entry point (unchanged structure)
│   │   └── database-adapter-electron.ts   # Electron DB adapter (extracted)
│   ├── preload/                           # Electron-only (preload script)
│   │   └── index.ts                       # IPC bridge (unchanged)
│   ├── worker/                            # Cloudflare Worker (NEW)
│   │   ├── index.ts                       # Entry point + route handlers
│   │   └── routes/                        # API route modules (optional split)
│   └── renderer/                          # Shared (React UI — minimal changes)
│       ├── index.html
│       └── src/
│           ├── App.tsx                    # Router change (Memory → Hash)
│           ├── main.tsx                   # API bridge initialization
│           └── components/                # Use unified window.api (no changes)
├── electron.vite.config.ts                # Unchanged
├── vite.config.worker.ts                  # NEW — Worker build config
├── tsconfig.node.json                     # Unchanged
├── tsconfig.web.json                      # Updated to include shared types
├── tsconfig.worker.json                   # NEW — Worker TS config
├── wrangler.toml                          # NEW — Cloudflare configuration
├── package.json                           # New scripts + dev dependencies
└── electron-builder.yml                   # Unchanged
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

---

## 6. Summary of Changes by Category

### New Files
- `src/lib/database/adapter.ts` — Database interface
- `src/lib/database/schema.sql` — D1 migration SQL
- `src/lib/api-bridge.ts` — Unified API bridge for renderer
- `src/worker/index.ts` — Cloudflare Worker entry point
- `vite.config.worker.ts` — Worker Vite configuration
- `tsconfig.worker.json` — Worker TypeScript config
- `wrangler.toml` — Cloudflare Workers configuration

### Modified Files
- `src/main/database.ts` → Extracted to adapter pattern; main process simplified
- `src/preload/index.d.ts` → Types moved to shared location
- `src/renderer/src/App.tsx` → Router change (MemoryRouter → HashRouter)
- `src/renderer/src/main.tsx` → API bridge initialization
- `package.json` → New scripts and dev dependencies

### Unchanged Files
- All renderer components (`src/renderer/src/components/*`) — use `window.api` which is abstracted
- `electron.vite.config.ts` — Electron build untouched
- `electron-builder.yml` — Desktop packaging unchanged
- Asset files (images, sounds) — bundled in both builds
