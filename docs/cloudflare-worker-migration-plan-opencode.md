# Cloudflare Worker Migration Plan — Full Migration (Electron Removed)

## Overview

This document outlines the plan to migrate **Hadoken High Roller** from an Electron desktop application to a **Cloudflare Workers + D1** web application. All Electron code, dependencies, and build tooling will be removed. The result is a single web app deployed to Cloudflare Workers with D1 for persistence.

---

## 1. Architecture Transformation

### Current Architecture (Electron)
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

### Target Architecture (Cloudflare Workers)
```
┌─────────────────────────────────────┐
│           Renderer (React)          │  ← Any browser
│   fetch('/api/*') → Worker routes   │
└──────────────┬──────────────────────┘
               │ HTTP (fetch API)
┌──────────────▼──────────────────────┐
│       Cloudflare Worker             │  ← V8 isolate
│   D1 (SQLite-compatible DB)         │
└─────────────────────────────────────┘
```

**Key simplification:** No abstraction layers, no adapter pattern, no API bridge. The Worker directly handles HTTP requests and queries D1. The renderer makes direct `fetch()` calls to the Worker's API endpoints.

---

## 2. Files to Remove (Electron-Only)

### Source Files
| File | Reason for Removal |
|---|---|
| `src/main/index.ts` | Electron main process entry point |
| `src/main/database.ts` | better-sqlite3 database layer (replaced by Worker + D1) |
| `src/preload/index.ts` | Electron preload script (contextBridge IPC bridge) |
| `src/preload/index.d.ts` | Electron preload type declarations |

### Build/Packaging Config
| File | Reason for Removal |
|---|---|
| `electron.vite.config.ts` | Electron-vite build config (replaced by Vite + Wrangler) |
| `electron-builder.yml` | Electron packaging config (no desktop builds needed) |

### Build Output & Artifacts
| File/Directory | Reason for Removal |
|---|---|
| `out/` | Electron build output directory |
| `build/icon.ico`, `build/icon.icns`, `build/icon.png` | Desktop app icons (not needed for web) |
| `resources/icon.png` | Linux tray icon (not needed for web) |
| `slotmachine.db` | Local SQLite test artifact (already should be gitignored) |

### VS Code Config
| File | Reason for Removal |
|---|---|
| `.vscode/launch.json` | Electron debug configuration (update or remove) |

---

## 3. Files to Modify

### Renderer Changes
| File | Change |
|---|---|
| `src/renderer/src/App.tsx` | Switch from `MemoryRouter` to `HashRouter`; Three.js/Vanta.js work as-is in browser renderer |
| `src/renderer/src/main.tsx` | Remove any Electron-specific imports; ensure clean React entry point |
| `src/renderer/index.html` | Remove CSP meta tag (use HTTP headers from Worker instead) |

### Component Changes
| File | Change |
|---|---|
| `src/renderer/src/components/Play.tsx` | Replace direct API calls (`window.api.startGame`, `recordSpin`, `endGame`) with fetch to Worker endpoints; handle HTTP errors |
| `src/renderer/src/components/PlayersList.tsx` | Replace direct API calls (`window.api.getLeaderboard`, `getOrCreatePlayer`) with fetch to Worker endpoints |
| `src/renderer/src/components/AddPlayer.tsx` | No direct API calls — uses callback pattern (`onAddPlayer`). The parent component (PlayersList.tsx) handles the fetch. |
| `src/renderer/src/components/GameOver.tsx` | No direct API calls — uses callback pattern (`onRestart`, `onHomeClick`). The parent component (Play.tsx) handles the fetch. |
| `src/renderer/src/components/Versions.tsx` | **Remove entirely** — shows Electron/Chrome/Node versions, meaningless in web context |

### Configuration Changes
| File | Change |
|---|---|
| `package.json` | Remove all Electron dependencies; add Wrangler, Cloudflare types; update scripts |
| `tsconfig.json` | Simplify — remove Electron-specific references |
| `tsconfig.node.json` | **Remove entirely** — no longer needed (no Electron main/preload) |
| `tsconfig.web.json` | **Remove entirely** — merge into single tsconfig |
| `.gitignore` | Update: remove `out/`, add `wrangler/`, `*.db*` patterns |
| `eslint.config.mjs` | Replace `@electron-toolkit/eslint-config-ts` and `@electron-toolkit/eslint-config-prettier` with standard React/TypeScript ESLint configs |
| `src/renderer/src/types.ts` | **Remove entirely** — contains only commented-out unused interfaces |

---

## 4. Files to Create

### Worker
| File | Purpose |
|---|---|
| `src/worker/index.ts` | Cloudflare Worker entry point with all API route handlers and static asset serving |
| `wrangler.toml` | Cloudflare Workers configuration (D1 binding, assets, compatibility settings) |

### Database
| File | Purpose |
|---|---|
| `src/lib/database/schema.sql` | Reference copy of D1 migration SQL (extracted from existing `database.ts`) — not used by wrangler, kept for documentation |
| `src/lib/database/migrations/0001_initial-schema.sql` | Actual D1 migration file used by `wrangler d1 migrations apply` (players, games, spins tables) |

### Types
| File | Purpose |
|---|---|
| `src/lib/types/api.ts` | Shared TypeScript types (Player, LeaderboardEntry) — extracted from old `preload/index.d.ts` |

### Build Config
| File | Purpose |
|---|---|
| `vite.config.ts` | New single Vite config for building the React renderer as a static SPA (output to `dist/renderer/`) |

---

## 5. Detailed Implementation Plan

### Phase 1: Extract Types and Database Schema

#### 5.1 Create Shared Types (`src/lib/types/api.ts`)
Extract from `src/preload/index.d.ts`:

```typescript
export interface Player {
  player_id: number
  name: string
  created_at: string
  highest_balance: number
  total_spins: number
}

export interface LeaderboardEntry {
  player_id: number
  name: string
  highest_balance: number
  total_spins: number
}

// Note: Player.balance is REMOVED — it does not exist in the database schema.
// Balance is computed dynamically from games/spins if needed.
```

#### 5.2 Create D1 Schema (`src/lib/database/schema.sql`)
Extract from `src/main/database.ts` function `createTables()` (lines 34-79, SQL statements at lines 38-72):

```sql
CREATE TABLE IF NOT EXISTS players (
  player_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
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

CREATE INDEX IF NOT EXISTS idx_spins_game_id ON spins(game_id);
CREATE INDEX IF NOT EXISTS idx_games_player_id ON games(player_id);
```

Key changes from original:
- Added `UNIQUE` constraint on `players.name` for safe upsert logic
- Added indexes on foreign key columns for query performance

---

### Phase 2: Build the Cloudflare Worker

#### 5.3 Worker Entry Point (`src/worker/index.ts`)

The Worker handles two responsibilities:
1. **API routes** — REST endpoints for the slot machine game logic
2. **Static assets** — Serve the built React SPA

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // API routes
    if (url.pathname === '/api/player/create' && request.method === 'POST') {
      return handleCreatePlayer(request, env)
    }
    if (url.pathname === '/api/game/start' && request.method === 'POST') {
      return handleStartGame(request, env)
    }
    if (url.pathname === '/api/spin/record' && request.method === 'POST') {
      return handleRecordSpin(request, env)
    }
    if (url.pathname === '/api/game/end' && request.method === 'POST') {
      return handleEndGame(request, env)
    }
    if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
      return handleGetLeaderboard(env)
    }

    // Serve static assets (React SPA)
    return env.ASSETS.fetch(request)
  },
}
```

#### 5.4 API Route Handlers

Each handler mirrors the logic from `src/main/database.ts` but uses D1's async API:

| Route | Method | Handler Function | Logic Source (database.ts) |
|---|---|---|---|
| `/api/player/create` | POST | `handleCreatePlayer()` | Lines 96-126 — SELECT + INSERT if not found |
| `/api/game/start` | POST | `handleStartGame()` | Lines 129-165 — INSERT into games |
| `/api/spin/record` | POST | `handleRecordSpin()` | Lines 168-257 — INSERT spin + UPDATE player stats (multi-step) |
| `/api/game/end` | POST | `handleEndGame()` | Lines 261-298 — UPDATE games SET ending_balance, end_time |
| `/api/leaderboard` | GET | `handleGetLeaderboard()` | Lines 302-321 — SELECT players ORDER BY highest_balance DESC LIMIT 10 |

**Critical: `record-spin` multi-step operation**
The spin recording handler performs multiple database operations that must be atomic:
1. Verify game exists (SELECT from games)
2. Insert spin record into `spins` table
3. Calculate current balance via JOIN query: `starting_balance + COALESCE(SUM(win_amount - bet_amount), 0)` across all spins in this game
4. Update player stats (`total_spins`, `highest_balance`)

In D1, steps 2 and 4 are executed via `env.DB.batch()` for atomicity. Step 3 is a separate SELECT (required before the UPDATE).

```typescript
async function handleRecordSpin(request: Request, env: Env): Promise<Response> {
  const { gameId, symbols, betAmount, winAmount } = await request.json()

  // Verify game exists and is active
  const game = await env.DB.prepare(
    'SELECT game_id, player_id, starting_balance FROM games WHERE game_id = ? AND end_time IS NULL'
  )
    .bind(gameId)
    .first()

  if (!game) {
    return new Response(JSON.stringify({ error: 'Game not found or already ended' }), { status: 404 })
  }

  // Insert spin record
  await env.DB.prepare(
    'INSERT INTO spins (game_id, symbols, bet_amount, win_amount) VALUES (?, ?, ?, ?)'
  ).bind(gameId, symbols, betAmount, winAmount)

  // Calculate current balance: starting_balance + SUM(all wins - all bets) for this game
  const result = await env.DB.prepare(
    `SELECT starting_balance + COALESCE(SUM(win_amount - bet_amount), 0) as current_balance,
            player_id
     FROM games
     LEFT JOIN spins ON games.game_id = spins.game_id
     WHERE games.game_id = ?
     GROUP BY games.game_id, games.starting_balance, games.player_id`
  )
    .bind(gameId)
    .first() as { current_balance: number; player_id: number }

  // Update player stats atomically with the spin insert above
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE players SET 
         total_spins = total_spins + 1,
         highest_balance = CASE WHEN ? > highest_balance THEN ? ELSE highest_balance END
       WHERE player_id = ?`
    ).bind(result.current_balance, result.current_balance, result.player_id),
  ])

  return new Response(JSON.stringify({ success: true, balance: result.current_balance }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
```

Note: The balance formula is `starting_balance + SUM(win_amount - bet_amount)` across ALL spins in the game, not just the current spin. This matches the original `database.ts` logic (lines 221-233).

#### 5.5 Wrangler Configuration (`wrangler.toml`)

```toml
name = "hadoken-high-roller"
main = "dist/worker/index.js"
compatibility_date = "2025-01-01"
node_compat = true

[dev]
port = 8787

[[d1_databases]]
binding = "DB"
database_name = "hadoken-high-roller"
database_id = ""
migrations_dir = "src/lib/database/migrations"

[assets]
directory = "dist/renderer"

[vars]
# Environment variables available in handler via env.VAR_NAME
```

---

### Phase 3: Update the Renderer

#### 5.6 Switch Router (`src/renderer/src/App.tsx`)
Change `MemoryRouter` to `HashRouter`:

```typescript
// Before
import { MemoryRouter as Router } from 'react-router-dom'

// After
import { HashRouter as Router } from 'react-router-dom'
```

This enables direct URL sharing and browser back/forward navigation when deployed as a web app.

#### 5.7 Three.js and Vanta.js Compatibility with Workers
Three.js and Vanta.js **do work** in the Cloudflare Workers runtime. The renderer runs in the user's browser (not inside the Worker), so all standard browser APIs are available — including `WebGL`, `requestAnimationFrame`, and the `Worker` constructor.

**No changes needed to Three.js or Vanta.js code.** The existing `App.tsx` initialization of WAVES (Vanta waves effect) works as-is.

#### 5.8 Update API Calls in Components
Replace all `window.api.*` calls with direct `fetch()` to Worker endpoints.

**Example — AddPlayer component:**
```typescript
// Before (Electron IPC)
const player = await window.api.getOrCreatePlayer(name)

// After (HTTP fetch)
const res = await fetch('/api/player/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name }),
})
if (!res.ok) throw new Error('Failed to create player')
const player = await res.json()
```

**Files requiring this change:**
- `src/renderer/src/components/Play.tsx` — `startGame`, `recordSpin`, `endGame` (6 occurrences of `window.api.*`)
- `src/renderer/src/components/PlayersList.tsx` — `getLeaderboard`, `getOrCreatePlayer` (2 occurrences of `window.api.*`)

Note: `AddPlayer.tsx` and `GameOver.tsx` use callback patterns (`onAddPlayer`, `onRestart`, `onHomeClick`) and do not directly call `window.api`. The parent components (PlayersList.tsx, Play.tsx) handle the fetch calls and pass results via props.

#### 5.9 Remove Versions Component
Delete `src/renderer/src/components/Versions.tsx` and remove its import from `App.tsx`. It displays Electron/Chrome/Node process versions which are meaningless in a web context.

#### 5.10 Remove CSP Meta Tag
Remove the `<meta http-equiv="Content-Security-Policy" ...>` tag from `src/renderer/index.html`. The Worker can set CSP via HTTP headers if needed, and the meta tag would restrict fetch calls to API endpoints.

#### 5.11 Update `index.html` Title
The `<title>` currently says "Electron" — change to "Hadoken High Roller".

Keep the `<div id="animation-container">` element — it is used by Vanta.js/Three.js for the animated wave background.

```html
<!-- Before -->
<title>Electron</title>

<!-- After -->
<title>Hadoken High Roller</title>
```

#### 5.12 Update `Splash.tsx` to Remove Versions Import
`src/renderer/src/components/Splash.tsx` imports and renders `Versions` (line 3, line 50). Since `Versions.tsx` is being removed:
- Remove the import: `import Versions from './Versions'`
- Remove the `<Versions />` element from the JSX

#### 5.13 Clean Up `src/renderer/src/types.ts`
This file exists at `src/renderer/src/types.ts` but contains only commented-out unused interfaces. Remove the entire file.

#### 5.14 Verify `MemoryRouter` → `HashRouter` Compatibility
The current `App.tsx` uses `MemoryRouter` with the `location` prop on `<Routes>`:
```tsx
<Routes location={displayLocation}>
```

When switching to `HashRouter`, verify that the `location` prop on `<Routes>` is still supported in the installed version of `react-router-dom` (v7.10.1). In react-router-dom v6+, the `location` prop was deprecated in favor of using `unstable_useBlocker` or custom routing logic. If the prop is no longer supported, the `AnimatedRoutes` component's transition logic may need to be rewritten using react-router-dom v7's `useBlocker` or a different animation approach.

---

### Phase 4: Build System

#### 5.15 New Vite Config (`vite.config.ts`)
Single Vite config for building the React SPA, with dev proxy to Worker API:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  build: {
    outDir: 'dist/renderer',
    sourcemap: true,
  },
  server: {
    // During local development, proxy /api/* calls to the Wrangler dev server.
    // `npm run dev` starts Vite on port 5173 (React SPA).
    // `npm run dev:worker` starts Wrangler on port 8787 (Worker + D1).
    // This proxy bridges them so fetch('/api/...') works during development.
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
```

**Local development workflow:** Run both servers simultaneously:
```bash
# Terminal 1 — React SPA with HMR on port 5173
npm run dev

# Terminal 2 — Worker + D1 on port 8787
npm run dev:worker
```

The Vite proxy ensures that `fetch('/api/player/create')` from the React app (port 5173) is forwarded to the Worker API (port 8787). In production, both are served from the same Worker via `[assets]` config, so no proxy is needed.

#### 5.16 Update ESLint Config (`eslint.config.mjs`)

Replace Electron-specific ESLint configs with standard React/TypeScript ones:

```typescript
import tseslint from 'typescript-eslint'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['**/node_modules', '**/dist', '**/.wrangler'] },
  ...tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: { react: { version: 'detect' } },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh,
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
    },
  },
  eslintConfigPrettier,
)
```

**Dependencies to add:** `typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `eslint-config-prettier`

**Dependencies to remove:** `@electron-toolkit/eslint-config-ts`, `@electron-toolkit/eslint-config-prettier`

#### 5.17 Single TypeScript Config (`tsconfig.json`)

Replace the root `tsconfig.json` (which currently references both sub-configs) with a single merged config. Delete `tsconfig.node.json` and `tsconfig.web.json`.

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@renderer/*": ["src/renderer/src/*"]
    }
  },
  "include": [
    "src/renderer/src/env.d.ts",
    "src/renderer/src/**/*",
    "src/lib/**/*",
    "src/worker/**/*"
  ],
  "exclude": ["node_modules"]
}
```

Key changes from the split configs:
- **No `extends`** — removes dependency on `@electron-toolkit/tsconfig`
- **No `"types"` field** — removes Electron-specific `electron-vite/node` types; Worker code gets types from `@cloudflare/workers-types` via the dev dependency
- **Explicitly includes `env.d.ts`** — ensures Vite client types (for `.png`, `.mp3?url` asset imports) are available
- **No `composite` or `outDir`** — project references are no longer needed with a single config
- **No `"main"` field** — the root `tsconfig.json` no longer needs to reference sub-configs via `"references"`

#### 5.18 Update `package.json`

**Remove from dependencies:**
- `better-sqlite3` (replaced by D1)
- `electron-store` (was unused anyway)

**Keep in dependencies:**
- `three` — works in browser runtime (renderer runs in user's browser, not Worker)
- `vanta` — works in browser runtime (depends on Three.js)

**Remove from devDependencies:**
- `electron` (^34.3.3)
- `electron-builder` (^25.1.8)
- `electron-vite` (^3.0.0)
- `@electron-toolkit/preload` (^3.0.1)
- `@electron-toolkit/utils` (^4.0.0)
- `@electron-toolkit/tsconfig`
- `@electron-toolkit/eslint-config-ts`
- `@electron-toolkit/eslint-config-prettier`

**Keep in devDependencies:**
- `@types/node` — not strictly needed (no Node.js runtime), but kept for utility types and won't cause harm
- `@types/react` / `@types/react-dom` — React type definitions
- `@vitejs/plugin-react` / `vite` — build tooling (replaces electron-vite)
- `eslint`, `prettier` — linting/formatting

**Add to devDependencies:**
- `wrangler` (^3.x) — Cloudflare Workers CLI and local development
- `@cloudflare/workers-types` (^4.x) — D1 type definitions
- `typescript-eslint` — Standard TypeScript ESLint parser and config (replaces @electron-toolkit/eslint-config-ts)
- `eslint-plugin-react` — React linting rules (already present, keep)
- `eslint-plugin-react-hooks` — React Hooks linting rules (already present, keep)
- `eslint-plugin-react-refresh` — Vite React Fast Refresh linting rules (already present, keep)
- `eslint-config-prettier` — Disables ESLint rules that conflict with Prettier (replaces @electron-toolkit/eslint-config-prettier)

**Update scripts:**
```json
{
  "scripts": {
    "format": "prettier --write .",
    "lint": "eslint --cache .",
    "typecheck": "tsc --noEmit",
    "dev": "vite",
    "build": "tsc --noEmit && vite build && wrangler deploy --dry-run",
    "preview": "vite preview",
    "dev:worker": "wrangler dev",
    "deploy": "vite build && wrangler deploy"
  }
}
```

**Remove from `package.json`:**
- `"main": "./out/main/index.js"` — points to Electron main process output, meaningless for a web app
- `"postinstall": "electron-builder install-app-deps"` — fails without electron-builder

**Update metadata:**
- `"description"` — change from "Electron application" to web app description
- `"homepage"` — update from `https://electron-vite.org` to actual deployment URL or remove

---

### Phase 5: Cleanup and Migration

#### 5.19 Remove Electron Files
Delete the following files/directories:
- `src/main/` (entire directory)
- `src/preload/` (entire directory)
- `electron.vite.config.ts`
- `electron-builder.yml`
- `tsconfig.node.json`
- `tsconfig.web.json`
- `out/` (build output)
- `build/icon.ico`, `build/icon.icns`, `build/icon.png`
- `resources/icon.png`
- `.vscode/launch.json`

#### 5.20 Update `.gitignore`
```
# Dependencies
node_modules/

# Build output
out/
dist/
.wrangler/

# Database files (local test artifacts)
*.db
*.db-wal
*.db-shm
slotmachine.db*

# OS files
.DS_Store
Thumbs.db

# IDE
.vscode/settings.json
*.log
```

#### 5.21 Update `.vscode/launch.json`
Remove Electron debug configurations. Add a simple Chrome debug config for web development:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "chrome",
      "request": "launch",
      "name": "Launch Vite",
      "url": "http://localhost:5173",
      "webRoot": "${workspaceFolder}/src/renderer"
    }
  ]
}
```

#### 5.22 Update `.prettierignore`
The current file ignores `out`, `tsconfig.json`, and `tsconfig.*.json`:
```
out
dist
pnpm-lock.yaml
LICENSE.md
tsconfig.json
tsconfig.*.json
```

After migration:
- Remove `out` — Electron build output no longer exists
- Remove `tsconfig.json` — single config should be formatted like all other files
- Remove `tsconfig.*.json` — sub-configs are being deleted
- Keep `dist` and `.wrangler/` (add explicitly)

```
dist
.wrangler/
pnpm-lock.yaml
LICENSE.md
```

#### 5.23 Update `README.md`
The current README (475 lines) contains extensive Electron-specific documentation. Key changes needed:
- Update project description (remove "Electron application" references)
- Replace Electron development instructions with Vite + Wrangler instructions
- Remove Electron build/packaging sections (`build:win`, `build:mac`, `build:linux`)
- Update architecture diagrams to show Cloudflare Workers + D1 instead of Electron main process
- Replace local SQLite database documentation with D1 setup instructions
- Update screenshots if any reference the Electron window chrome
- Add Cloudflare deployment instructions

## 6. D1 Database Setup Workflow

### Local Development
```bash
# Create the D1 database in your Cloudflare account
wrangler d1 create hadoken-high-roller

# Create the initial migration file
wrangler d1 migrations create hadoken-high-roller initial-schema

# Apply migrations locally (creates a SQLite file for local dev)
wrangler d1 migrations apply hadoken-high-roller --local

# Start local Worker with D1 emulation
npm run dev:worker
```

### Production Deployment
```bash
# Update wrangler.toml with the production database UUID
# Then deploy:
npm run deploy

# Or manually:
wrangler deploy
```

### Ad-hoc Queries (Debugging)
```bash
# Query production database
wrangler d1 execute hadoken-high-roller --remote --command "SELECT * FROM players"

# Query local database
wrangler d1 execute hadoken-high-roller --local --command "SELECT * FROM players"
```

---

## 7. File Structure After Migration

```
hadoken-high-roller/
├── docs/
│   └── cloudflare-worker-migration-plan-opencode.md  # This document
├── src/
│   ├── lib/                                  # Shared code
│   │   ├── types/
│   │   │   └── api.ts                        # Player, LeaderboardEntry interfaces
│   │   └── database/
│   │       ├── schema.sql                    # D1 migration SQL (reference)
│   │       └── migrations/
│   │           └── 0001_initial-schema.sql   # wrangler migration file
│   ├── worker/                               # Cloudflare Worker
│   │   └── index.ts                          # Entry point + all API routes + static serving
│   └── renderer/                             # React SPA (web only)
│       ├── index.html                        # CSP meta tag removed
│       └── src/
│           ├── main.tsx                      # React entry point (clean)
│           ├── App.tsx                       # HashRouter, Vanta.js/Three.js preserved
│           └── components/                   # Updated for fetch-based API calls
│               ├── AddPlayer.tsx
│               ├── CoinCounter.tsx
│               ├── Error.tsx
│               ├── GameOver.tsx
│               ├── Home.tsx
│               ├── Logo.tsx
│               ├── Play.tsx
│               ├── PlayersList.tsx
│               ├── RetroButton.tsx
│               ├── RewardModal.tsx
│               ├── SlotMachine.tsx
│               ├── SlotReel.tsx
│               └── SpinButton.tsx
├── vite.config.ts                            # NEW — single Vite config for renderer
├── wrangler.toml                             # NEW — Cloudflare Workers config
├── tsconfig.json                             # MODIFIED — single merged config
├── package.json                              # MODIFIED — Electron deps removed, Wrangler added
├── .gitignore                                # MODIFIED — updated patterns
└── README.md                                 # Update with new deployment instructions
```

---

## 8. Summary of Changes by Category

### Files Created (5)
| File | Purpose |
|---|---|
| `src/worker/index.ts` | Cloudflare Worker entry point with API routes and static asset serving |
| `wrangler.toml` | Cloudflare Workers configuration (D1, assets, compatibility) |
| `src/lib/types/api.ts` | Shared TypeScript types (Player, LeaderboardEntry) |
| `src/lib/database/migrations/0001_initial-schema.sql` | D1 initial migration |
| `vite.config.ts` | Single Vite config for building the React SPA |

### Files Modified (10)
| File | Change |
|---|---|
| `src/renderer/src/App.tsx` | MemoryRouter → HashRouter; Three.js/Vanta.js work as-is in browser renderer |
| `src/renderer/src/main.tsx` | Remove Electron-specific imports if any |
| `src/renderer/index.html` | Title changed, CSP meta tag removed, animation-container div kept for Vanta.js |
| `src/renderer/src/components/Splash.tsx` | Remove Versions import and element |
| `package.json` | Remove Electron/better-sqlite3 deps; add wrangler + @cloudflare/workers-types; update scripts; remove `main` field, `postinstall` script; update description/homepage |
| `tsconfig.json` | Replace root file with single merged config (replaces tsconfig.node.json + tsconfig.web.json); explicitly includes env.d.ts for Vite client types |
| `eslint.config.mjs` | Replace @electron-toolkit ESLint configs with standard React/TypeScript ones |
| `.vscode/launch.json` | Replace Electron debug config with Chrome debug config |
| `.prettierignore` | Remove `out`, `tsconfig.json`, `tsconfig.*.json`; add `.wrangler/` |
| `README.md` | Replace Electron docs with Cloudflare Workers + D1 instructions (475 lines to update) |

### Files Deleted (15)
| File/Directory | Reason |
|---|---|
| `src/main/index.ts` | Electron main process |
| `src/main/database.ts` | better-sqlite3 database layer |
| `src/preload/index.ts` | Electron preload script |
| `src/preload/index.d.ts` | Preload type declarations |
| `electron.vite.config.ts` | Electron-vite build config |
| `electron-builder.yml` | Electron packaging config |
| `tsconfig.node.json` | Merged into single tsconfig |
| `tsconfig.web.json` | Merged into single tsconfig |
| `src/renderer/src/components/Versions.tsx` | Electron version display (meaningless in web) |
| `src/renderer/src/types.ts` | Contains only commented-out unused interfaces |
| `out/` | Electron build output |
| `build/icon.ico`, `build/icon.icns`, `build/icon.png` | Desktop app icons |
| `resources/icon.png` | Linux tray icon |
| `.vscode/launch.json` | Electron debug config (replaced with Chrome config) |
| `slotmachine.db` | Local SQLite test artifact |

### Dependencies Removed (11)
| Package | Category |
|---|---|
| `electron` | Dev — Electron runtime |
| `electron-builder` | Dev — Packaging |
| `electron-vite` | Dev — Build tooling |
| `@electron-toolkit/preload` | Runtime — Preload bridge |
| `@electron-toolkit/utils` | Runtime — Electron utilities |
| `@electron-toolkit/tsconfig` | Dev — TypeScript config |
| `@electron-toolkit/eslint-config-ts` | Dev — ESLint config (replaced by typescript-eslint) |
| `@electron-toolkit/eslint-config-prettier` | Dev — ESLint config (replaced by eslint-config-prettier) |
| `better-sqlite3` | Runtime — Local SQLite (replaced by D1) |
| `electron-store` | Runtime — Config storage (unused, file-system dependent) |

### Dependencies Added (2)
| Package | Category | Purpose |
|---|---|---|
| `wrangler` | Dev | Cloudflare Workers CLI + local dev server with D1 emulation |
| `@cloudflare/workers-types` | Dev | TypeScript types for D1, Workers runtime APIs |

### Dependencies Replaced (2)
| Old Package | New Package | Reason |
|---|---|---|
| `@electron-toolkit/eslint-config-ts` | `typescript-eslint` (already installed as peer dep) | Standard TypeScript ESLint config |
| `@electron-toolkit/eslint-config-prettier` | `eslint-config-prettier` (already installed) | Standard Prettier integration |

### Dependencies Already Present (kept, no change needed)
| Package | Category | Reason |
|---|---|---|
| `eslint-plugin-react` | Dev | React linting rules (already in devDependencies) |
| `eslint-plugin-react-hooks` | Dev | React Hooks linting rules (already in devDependencies) |
| `eslint-plugin-react-refresh` | Dev | Vite React Fast Refresh linting rules (already in devDependencies) |
| `eslint` | Dev | ESLint core (already in devDependencies) |
| `prettier` | Dev | Prettier formatting (already in devDependencies) |
| `@types/node` | Dev | Node.js types — not strictly needed but kept for utility types |
| `@types/react` / `@types/react-dom` | Dev | React type definitions (already in devDependencies) |

### Dependencies Kept (unchanged)
| Package | Category | Reason |
|---|---|---|
| `react` / `react-dom` | Runtime | Core UI framework |
| `react-router-dom` | Runtime | Routing (switched to HashRouter) |
| `three` | Runtime — 3D engine | Works in browser (renderer runs in user's browser) |
| `vanta` | Runtime — Visual effects | Works in browser (depends on Three.js) |
| `@vitejs/plugin-react` | Dev | Vite React plugin |
| `vite` | Dev — Build tooling | Bundler (replaces electron-vite) |
| `typescript` | Dev — Type checking | Language |

---

## 9. API Endpoint Mapping (Electron IPC → HTTP)

| Old IPC Channel | New HTTP Route | Method | Component Usage |
|---|---|---|---|
| `getOrCreatePlayer` | `/api/player/create` | POST | AddPlayer.tsx |
| `startGame` | `/api/game/start` | POST | Play.tsx, GameOver.tsx |
| `recordSpin` | `/api/spin/record` | POST | Play.tsx |
| `endGame` | `/api/game/end` | POST | Play.tsx, GameOver.tsx |
| `getLeaderboard` | `/api/leaderboard` | GET | PlayersList.tsx |

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Three.js / Vanta.js bundle size impact on renderer | Larger JS bundle (~600KB minified) | Acceptable for a game; assets are small (16 PNGs + 10 MP3s) |
| D1 query performance vs local SQLite | Slower spin recording / leaderboard | Use `db.batch()` for multi-statement ops; add indexes on FK columns |
| Bundle size limits (5 MB free tier) | Large asset bundles may exceed limits | Monitor bundle size; total is well under the limit |
| HashRouter SEO / deep linking | Users can't share direct game URLs | Acceptable for a slot machine game; HashRouter is the right choice |
| No server-side sessions | Game state must be fully in D1 | Current design already stores all state in DB — no change needed |
| CORS between static assets and API | Fetch calls blocked if on different origins | Served from same Worker via `[assets]` config — no CORS needed |
| D1 not available locally without wrangler setup | Developer friction for new contributors | Document `wrangler` setup in README; use SQLite file emulation |
| Migration of existing player data from local SQLite to D1 | Existing Electron users lose their data | Provide a data export/import mechanism in the UI (optional, post-launch) |
| ESLint config uses deprecated Electron-specific presets | Linting breaks during migration | Replace with standard `typescript-eslint` + React plugins early in the process |
| react-router-dom v7 deprecates `location` prop on `<Routes>` | Route transition animations break | Test `HashRouter` with the existing `AnimatedRoutes` component; fall back to CSS-based transitions if needed |
| Vite dev server (port 5173) cannot reach Worker API (port 8787) during local development | API calls fail in dev mode | Configure Vite `server.proxy` to forward `/api/*` to `localhost:8787`; run both servers in parallel |
| `package.json` metadata not cleaned up (`main`, `postinstall`) | `npm install` fails with electron-builder error; stale metadata in published package | Remove `main` field and `postinstall` script; update description/homepage (Step 6) |
| `README.md` not updated with new architecture | Users follow outdated Electron instructions | Rewrite README with Cloudflare Workers + D1 docs (Step 7) |

---

## 11. Implementation Order

### Step 1: Set up Worker skeleton
- Create `src/worker/index.ts` with basic route structure and static asset serving
- Create `wrangler.toml` with D1 binding (empty database_id for now)
- Add `wrangler` and `@cloudflare/workers-types` to devDependencies

### Step 2: Create database schema
- Create `src/lib/database/schema.sql` and migration file
- Run `wrangler d1 create hadoken-high-roller` to get database UUID
- Run `wrangler d1 migrations apply --local` to set up local DB

### Step 3: Implement API handlers
- Port all 5 IPC handlers from `src/main/database.ts` to Worker route handlers
- Use D1's async prepared statement API (`env.DB.prepare().bind()`)
- Use `db.batch()` for multi-statement operations (record-spin)

### Step 4: Update renderer
- Switch to HashRouter in `App.tsx` (verify `location` prop compatibility with react-router-dom v7)
- Three.js and Vanta.js work as-is in the browser renderer — no changes needed
- Update all components to use `fetch()` instead of `window.api.*`
- Remove `Versions.tsx` component and update `Splash.tsx` to remove its import
- Update `index.html` title from "Electron" to "Hadoken High Roller"
- Remove CSP meta tag from `index.html`
- Delete `src/renderer/src/types.ts` (commented-out unused interfaces)

### Step 5: Clean up build system
- Create single `vite.config.ts` for renderer build (with dev proxy to Worker on port 8787)
- Replace root `tsconfig.json` with single merged config (delete tsconfig.node.json + tsconfig.web.json)
- Replace ESLint config: swap `@electron-toolkit/eslint-config-*` for standard React/TypeScript ESLint
- Update `.prettierignore`: remove `out`, `tsconfig.json`, `tsconfig.*.json`; add `.wrangler/`
- Remove all Electron dependencies and config files

### Step 6: Clean up package.json metadata
- Remove `"main": "./out/main/index.js"` field (points to Electron output)
- Remove `"postinstall": "electron-builder install-app-deps"` (fails without electron-builder)
- Update `"description"` to remove "Electron application" reference
- Update or remove `"homepage"` (currently points to electron-vite.org)

### Step 7: Update documentation
- Rewrite `README.md` (475 lines): replace Electron docs with Cloudflare Workers + D1 instructions
- Update architecture diagrams, development instructions, build/packaging sections

### Step 8: Test locally
- Run `npm run dev` for renderer HMR (Vite dev server)
- Run `npm run dev:worker` for Worker + D1 local emulation
- Test all 5 API endpoints against local D1

### Step 9: Deploy
- Run `wrangler deploy` to deploy to Cloudflare Workers

---

## 12. Data Migration (Optional — Post-Launch)

If existing Electron users need to migrate their data:

1. **Export from Electron:** Add a "Export Data" button in the existing Electron app that exports all players, games, and spins as JSON.

2. **Import to D1:** Create a one-time import endpoint on the Worker:
   ```typescript
   // /api/data/import — POST with JSON body containing players, games, spins arrays
   ```

3. **Announce migration window:** Let users know about the transition and provide a timeframe for data export/import.

This is optional and can be done after the initial migration if needed. The simpler approach is to start fresh with no historical data.
