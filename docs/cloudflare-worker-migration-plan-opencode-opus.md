# Cloudflare Worker / D1 Migration Plan — Hadoken High Roller

> Migrate the Electron desktop app to a web application served and deployed from a
> single Cloudflare Worker, backed by Cloudflare D1. All Electron code and files
> are removed.

## 1. Goal & Decisions

Convert **Hadoken High Roller** (a Street Fighter–themed slot machine React app)
from an Electron desktop app into a web app deployable to **Cloudflare Workers** +
**D1**, removing all Electron-specific code, dependencies, and build tooling.

Decisions confirmed with the stakeholder:

| Topic | Decision |
|-------|----------|
| Project layout | **Single repo / single Worker** serves the static SPA (Workers Assets) and the `/api/*` routes against D1. One `wrangler.toml`. |
| Frontend router | **`BrowserRouter`** with SPA fallback (Worker serves `index.html` for non-API, non-asset paths). |
| Reward calculation | **Stays client-side** (`calculateReward` unchanged). The Worker only records reported spins. |
| Player identity | **Name-based, no auth.** Preserve current `getOrCreatePlayer` behavior + public leaderboard. |

### Target architecture

```
Browser (React SPA, BrowserRouter)
        │  fetch('/api/...')                static assets ('/', '/assets/*')
        ▼                                          ▲
┌───────────────────────────────────────────────────────────┐
│  Cloudflare Worker (single deployment)                      │
│   • Static asset serving (Workers Assets, SPA fallback)     │
│   • Router for /api/* (Hono or hand-rolled)                 │
│   • D1 binding (env.DB) — async SQL                         │
└───────────────────────────────────────────────────────────┘
        │
        ▼
   Cloudflare D1 (players, games, spins)
```

The renderer stays almost entirely intact (React components, three.js/Vanta
background, sounds, symbols, `calculateReward`). The Electron **main** and
**preload** processes are replaced by a **Worker API** + a **typed `fetch`
client**.

---

## 2. Current State (what we are migrating from)

### 2.1 Electron surfaces to remove/replace

| Electron surface | Location | Replacement |
|---|---|---|
| `app` lifecycle, `BrowserWindow`, `shell`, `?asset` icon | `src/main/index.ts` | Removed entirely |
| 5 × `ipcMain.handle` | `src/main/database.ts:96–321` | HTTP routes on the Worker |
| `better-sqlite3` (synchronous) | `src/main/database.ts` | Cloudflare **D1** (async) |
| `app.getPath('userData')/slotmachine.db` | `src/main/database.ts:13–14` | D1 binding (`env.DB`) |
| `contextBridge` / `window.api` / `window.electron` | `src/preload/index.ts`, `index.d.ts` | Typed `fetch` API client |
| `window.electron.process.versions` | `src/renderer/src/components/Versions.tsx:4` | Remove component (or static text) |
| `MemoryRouter` | `src/renderer/src/App.tsx:78` | `BrowserRouter` |
| electron-vite / electron-builder build | `electron.vite.config.ts`, `electron-builder.yml`, `package.json` scripts | Vite (web) + Wrangler |

> **Note:** No `electron-store` is used. All persistence is the SQLite file plus
> transient React state in `Play.tsx`.

### 2.2 The IPC contract (becomes the HTTP API)

From `src/preload/index.ts` and `src/main/database.ts`:

| IPC channel | Args | Returns | Handler |
|---|---|---|---|
| `get-or-create-player` | `playerName: string` | `Player` | `database.ts:96` |
| `start-game` | `playerId, startingBalance` | `{ gameId }` | `database.ts:129` |
| `record-spin` | `gameId, symbols, betAmount, winAmount` | `{ spinId }` | `database.ts:169` |
| `end-game` | `gameId, endingBalance` | `void` | `database.ts:261` |
| `get-leaderboard` | — | `LeaderboardEntry[]` | `database.ts:302` |

Renderer call sites (all via `window.api.*`):
`PlayersList.tsx:35` (`getLeaderboard`), `PlayersList.tsx:47` (`getOrCreatePlayer`),
`Play.tsx:179,237` (`startGame`), `Play.tsx:330` (`recordSpin`),
`Play.tsx:213,351,408` (`endGame`).

### 2.3 Database schema (ports to D1 directly)

```
players (1) ──< games (many) ──< spins (many)
```

- **players**: `player_id` PK AUTOINCREMENT, `name` NOT NULL, `created_at`
  DEFAULT CURRENT_TIMESTAMP, `highest_balance` DEFAULT 0, `total_spins` DEFAULT 0.
- **games**: `game_id` PK AUTOINCREMENT, `player_id` NOT NULL FK→players,
  `start_time` DEFAULT CURRENT_TIMESTAMP, `end_time` (nullable),
  `starting_balance` NOT NULL, `ending_balance` (nullable).
- **spins**: `spin_id` PK AUTOINCREMENT, `game_id` NOT NULL FK→games,
  `timestamp` DEFAULT CURRENT_TIMESTAMP, `symbols` TEXT NOT NULL,
  `bet_amount` NOT NULL, `win_amount` NOT NULL.
- Seed: a default `'Player 1'` row when `players` is empty.

> D1 enforces foreign keys by default; the `journal_mode = WAL` pragma is not
> applicable to D1 and is dropped.

---

## 3. Target Project Layout

```
hadoken-high-roller/
├── src/
│   ├── client/                 # (renamed from renderer/src) React SPA
│   │   ├── main.tsx
│   │   ├── App.tsx             # BrowserRouter
│   │   ├── env.d.ts
│   │   ├── api/
│   │   │   └── client.ts       # NEW: typed fetch client (replaces window.api)
│   │   ├── assets/             # css, sounds/, symbols/, logo (unchanged)
│   │   ├── lib/symbols.ts      # unchanged (calculateReward stays client-side)
│   │   └── components/         # unchanged except Versions removed & api calls swapped
│   ├── worker/                 # NEW: Cloudflare Worker (replaces main/ + preload/)
│   │   ├── index.ts            # Worker entry: routes /api/*, serves SPA
│   │   ├── db.ts               # D1 query functions (port of database.ts handlers)
│   │   └── types.ts            # Player, LeaderboardEntry, API request/response types
│   └── shared/                 # (optional) shared TS types between client & worker
├── index.html                  # moved to repo root (Vite web entry)
├── migrations/
│   └── 0001_init.sql           # D1 schema + seed
├── vite.config.ts              # NEW: plain Vite (was electron.vite.config.ts)
├── wrangler.toml               # NEW: Worker + D1 + assets config
├── tsconfig.json
├── tsconfig.client.json        # (was tsconfig.web.json)
├── tsconfig.worker.json        # (was tsconfig.node.json)
├── package.json                # rewritten scripts & deps
└── README.md                   # rewritten for web
```

> Renaming `renderer/src` → `client` and `main`+`preload` → `worker` is optional
> but recommended for clarity. The plan below assumes these names; if minimal diff
> is preferred, keep `src/renderer/src` and add `src/worker` only.

---

## 4. Files to DELETE

| Path | Reason |
|---|---|
| `src/main/index.ts` | Electron main process (BrowserWindow/app lifecycle) |
| `src/main/database.ts` | Replaced by `src/worker/db.ts` (logic ported) |
| `src/main/` (whole dir) | Electron main process |
| `src/preload/index.ts` | contextBridge / IPC bridge |
| `src/preload/index.d.ts` | Types moved to `src/worker/types.ts` / `src/shared` |
| `src/preload/` (whole dir) | Electron preload |
| `src/renderer/src/components/Versions.tsx` | Uses `window.electron.process.versions` |
| `src/renderer/types.ts` | Dead file (all commented out) |
| `src/renderer/src/assets/electron.svg` | Electron branding asset |
| `electron.vite.config.ts` | Electron build config |
| `electron-builder.yml` | Electron packaging config |
| `slotmachine.db` | Local SQLite file (data lives in D1 now) |
| `build/` | Electron build resources (entitlements, icons) — verify contents first |
| `resources/` (icon.png etc.) | Electron app icon/resources — verify; keep any web-needed favicon |
| `out/` | Electron build output (already gitignored typically) |
| `.yarnrc.yml` / `.yarn/` | Optional: only if switching off Yarn (see §10) |

> Before deleting `build/` and `resources/`, confirm they contain only Electron
> assets. **Confirmed contents:** `build/` = `icon.png`/`icon.ico`/`icon.icns`,
> `resources/` = `icon.png`. **Action (see §12.12):** copy one PNG to serve as the
> web favicon (e.g. `public/favicon.ico`) and reference it from `index.html` before
> deleting these dirs — otherwise the web app has no favicon.

---

## 5. Files to CREATE

### 5.1 `wrangler.toml`

```toml
name = "hadoken-high-roller"
main = "src/worker/index.ts"
compatibility_date = "2024-09-23"

# Serve the built SPA from the Worker with SPA fallback
[assets]
directory = "./dist/client"
binding = "ASSETS"
not_found_handling = "single-page-application"

[[d1_databases]]
binding = "DB"
database_name = "hadoken-high-roller"
database_id = "<filled in after `wrangler d1 create`>"
migrations_dir = "migrations"
```

### 5.2 `migrations/0001_init.sql` (port of `createTables`)

```sql
CREATE TABLE IF NOT EXISTS players (
  player_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  highest_balance INTEGER DEFAULT 0,
  total_spins     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
  game_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id        INTEGER NOT NULL,
  start_time       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  end_time         TIMESTAMP,
  starting_balance INTEGER NOT NULL,
  ending_balance   INTEGER,
  FOREIGN KEY (player_id) REFERENCES players (player_id)
);

CREATE TABLE IF NOT EXISTS spins (
  spin_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL,
  timestamp  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  symbols    TEXT NOT NULL,
  bet_amount INTEGER NOT NULL,
  win_amount INTEGER NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games (game_id)
);

-- Seed default player (idempotent)
INSERT INTO players (name)
SELECT 'Player 1'
WHERE NOT EXISTS (SELECT 1 FROM players);
```

> Recommended index for the leaderboard:
> `CREATE INDEX IF NOT EXISTS idx_players_highest ON players (highest_balance DESC);`

### 5.3 `src/worker/types.ts`

Port `Player`, `LeaderboardEntry`, and request/response shapes from
`src/preload/index.d.ts`. (Drop the phantom `balance` field that never existed as
a column.)

### 5.4 `src/worker/db.ts` — D1 port of the 5 handlers

Each `ipcMain.handle` becomes an async function taking the D1 binding. Key
translation rules:

- `db.prepare(sql).get(...args)` → `await env.DB.prepare(sql).bind(...args).first()`
- `db.prepare(sql).all(...args)` → `(await env.DB.prepare(sql).bind(...).all()).results`
- `db.prepare(sql).run(...args)` → `await env.DB.prepare(sql).bind(...).run()`;
  use `meta.last_row_id` instead of `lastInsertRowid`, and `meta.changes`.
- Keep all the existing validation (positive integers, non-empty strings, "player
  exists" / "game exists" checks) and the same SQL bodies, including the
  `record-spin` balance recompute and player-stats update (`database.ts:220–250`).

Functions: `getOrCreatePlayer`, `startGame`, `recordSpin`, `endGame`,
`getLeaderboard`.

### 5.5 `src/worker/index.ts` — Worker entry + router

```ts
export interface Env {
  DB: D1Database
  ASSETS: Fetcher
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, env, url)   // routes to db.ts functions, JSON in/out
    }
    return env.ASSETS.fetch(req)        // static SPA + SPA fallback
  }
}
```

Recommended endpoint mapping (REST-ish, JSON bodies):

| Method + path | Calls | Replaces IPC |
|---|---|---|
| `POST /api/players`            | `getOrCreatePlayer(name)` | `get-or-create-player` |
| `GET  /api/leaderboard`        | `getLeaderboard()` | `get-leaderboard` |
| `POST /api/games`              | `startGame(playerId, startingBalance)` | `start-game` |
| `POST /api/games/:id/spins`    | `recordSpin(gameId, symbols, bet, win)` | `record-spin` |
| `POST /api/games/:id/end`      | `endGame(gameId, endingBalance)` | `end-game` |

- Return `application/json`; map thrown validation errors to `400`, missing
  player/game to `404`, unexpected to `500`.
- Single-origin (Worker serves SPA + API) → **no CORS needed**.

> Optionally use **Hono** for ergonomic routing/validation; otherwise a small
> hand-rolled `switch` is sufficient for 5 endpoints.

### 5.6 `src/client/api/client.ts` — typed fetch client (replaces `window.api`)

Mirror the old `AppAPI` interface exactly so component call sites change minimally:

```ts
export const api = {
  getOrCreatePlayer: (name: string) =>
    post<Player>('/api/players', { playerName: name }),
  startGame: (playerId: number, startingBalance: number) =>
    post<{ gameId: number }>('/api/games', { playerId, startingBalance }),
  recordSpin: (gameId: number, symbols: string, betAmount: number, winAmount: number) =>
    post<{ spinId: number }>(`/api/games/${gameId}/spins`, { symbols, betAmount, winAmount }),
  endGame: (gameId: number, endingBalance: number) =>
    post<void>(`/api/games/${gameId}/end`, { endingBalance }),
  getLeaderboard: () => get<LeaderboardEntry[]>('/api/leaderboard'),
}
```

### 5.7 `vite.config.ts` (plain web Vite)

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: '.',
  build: { outDir: 'dist/client' },
  resolve: { alias: { '@renderer': resolve(__dirname, 'src/client') } },
  plugins: [react()],
  server: {
    // Dev: proxy /api to local Worker (wrangler dev) so fetch('/api/...') works
    proxy: { '/api': 'http://localhost:8787' },
  },
})
```

### 5.8 `index.html` (root)

Move `src/renderer/index.html` to repo root; update:
- `<title>` → `Hadoken High Roller`.
- Fix the script path to point at the client entry (`/src/client/main.tsx`).
- Relax/adjust the CSP for the web (the current `default-src 'self'` will block the
  Vanta canvas fine, but verify; sounds/images are same-origin). Keep
  `#animation-container` and `#root`.

---

## 6. Files to MODIFY (renderer → client)

| File | Change |
|---|---|
| `src/renderer/src/App.tsx` | `MemoryRouter` → `BrowserRouter`; drop `initialEntries`. Add an index redirect so `/` lands on `/splash` (e.g. `<Route path="/" element={<Navigate to="/splash" />} />`). three.js/Vanta untouched. |
| `src/renderer/src/components/PlayersList.tsx` | Replace `window.api.getLeaderboard()` / `getOrCreatePlayer()` with `import { api } from '../api/client'`. Calls become `await api.getLeaderboard()` etc. Logic unchanged. **Also:** `LeaderboardEntry` is currently declared locally here (lines 6–11) — point it at the shared type. |
| `src/renderer/src/components/Play.tsx` | Replace 6 × `window.api.*` (`startGame` ×2, `recordSpin`, `endGame` ×3) with the `api` client. **⚠ Router-state bug (§12.1):** `playerName` is read from `useLocation().state` (line 152) and will be `undefined` on a hard refresh/deep-link under `BrowserRouter` — must add a fallback (fetch the player or tolerate missing name). `calculateReward` stays. |
| `src/renderer/src/components/Splash.tsx` | Remove **both** the `import Versions from './Versions'` (line 3) and the `<Versions />` render (line 50). |
| `src/renderer/src/main.tsx` | Update asset import path if `main.css` moves; otherwise unchanged. |
| `src/renderer/src/env.d.ts` | Keep `vite/client` ref; remove any preload global typing reliance. |
| (global) | Remove the `Window { api; electron }` ambient typing (was in `preload/index.d.ts`); no longer referenced. |

> If the `renderer/src` → `client` rename is adopted, update the `@renderer` alias
> consumers and tsconfig `include` paths accordingly. Components otherwise need no
> structural change — they call `api.*` instead of `window.api.*`.

---

## 7. Config & Dependency Changes

### 7.1 `package.json`

**Remove dependencies:**
`@electron-toolkit/preload`, `@electron-toolkit/utils`, `better-sqlite3`,
`electron-store`.

**Remove devDependencies:**
`@electron-toolkit/eslint-config-prettier`, `@electron-toolkit/eslint-config-ts`,
`@electron-toolkit/tsconfig`, `electron`, `electron-builder`, `electron-vite`.

**Add devDependencies:**
`wrangler`, `@cloudflare/workers-types`, (optional) `hono`,
(optional) `@cloudflare/vite-plugin` if using the integrated build.

**Keep:** `react`, `react-dom`, `react-router-dom`, `three`, `vanta`, `vite`,
`@vitejs/plugin-react`, `typescript`, eslint/prettier plugins (swap the
electron-toolkit eslint configs for plain configs).

**Rewrite scripts:**

```jsonc
{
  "scripts": {
    "dev": "vite",                         // SPA dev server (proxies /api → wrangler)
    "dev:worker": "wrangler dev",          // local Worker + D1
    "build": "npm run typecheck && vite build",
    "preview": "wrangler dev",             // serve built assets + API locally
    "deploy": "npm run build && wrangler deploy",
    "db:create": "wrangler d1 create hadoken-high-roller",
    "db:migrate": "wrangler d1 migrations apply hadoken-high-roller",
    "db:migrate:local": "wrangler d1 migrations apply hadoken-high-roller --local",
    "typecheck": "npm run typecheck:client && npm run typecheck:worker",
    "typecheck:client": "tsc --noEmit -p tsconfig.client.json",
    "typecheck:worker": "tsc --noEmit -p tsconfig.worker.json",
    "lint": "eslint --cache .",
    "format": "prettier --write ."
  }
}
```

Also remove `"main": "./out/main/index.js"`, the `postinstall`
(`electron-builder install-app-deps`), and the `homepage` pointing to electron-vite.

### 7.2 tsconfig

- `tsconfig.node.json` → `tsconfig.worker.json`: stop extending
  `@electron-toolkit/tsconfig`; use a Worker-appropriate config with
  `"types": ["@cloudflare/workers-types"]`, `include: ["src/worker/**/*"]`,
  `lib: ["ES2022"]`, `module: "ESNext"`, `moduleResolution: "Bundler"`.
- `tsconfig.web.json` → `tsconfig.client.json`: stop extending electron-toolkit;
  use a DOM web config (`lib: ["DOM","DOM.Iterable","ES2022"]`, `jsx: react-jsx`,
  `types: ["vite/client"]`), `include: ["src/client/**/*"]`, keep the `@renderer`
  path alias.
- `tsconfig.json`: update `references` to the two renamed projects.

### 7.3 ESLint / Prettier

- Replace `@electron-toolkit/eslint-config-*` in `eslint.config.mjs` with the
  standard `@eslint/js` + `typescript-eslint` + the existing react plugins.
- `.prettierrc.yaml` / `.editorconfig` unchanged.

### 7.4 `.gitignore`

Add `dist/`, `.wrangler/`, `.dev.vars`. Remove now-irrelevant `out/` (or keep).

---

## 8. Migration Steps (execution order)

1. **Branch & snapshot.** Create a migration branch. Confirm the app builds today
   (`yarn build`) for a baseline.
2. **Scaffold Worker + D1 config.** Add `wrangler.toml`, `migrations/0001_init.sql`,
   `src/worker/{index,db,types}.ts`. Run `wrangler d1 create hadoken-high-roller`
   and paste the `database_id` into `wrangler.toml`.
3. **Port the data layer.** Translate the 5 handlers from `database.ts` into
   `src/worker/db.ts` (async D1), preserving validation and SQL. Wire the HTTP
   routes in `src/worker/index.ts`.
4. **Apply migrations locally.** `wrangler d1 migrations apply hadoken-high-roller --local`;
   smoke-test endpoints with `wrangler dev` + curl.
5. **Add the client API.** Create `src/client/api/client.ts` mirroring `AppAPI`.
6. **Swap renderer calls.** Replace `window.api.*` in `PlayersList.tsx` and
   `Play.tsx`. Remove `Versions` usage in `Splash.tsx`.
7. **Switch router.** `MemoryRouter` → `BrowserRouter` in `App.tsx`; add `/` →
   `/splash` redirect.
8. **Web build wiring.** Add root `index.html`, `vite.config.ts`; (optionally)
   rename `renderer/src` → `client`; update tsconfig/aliases.
9. **Strip Electron.** Delete files in §4; remove Electron deps/scripts in
   `package.json`; update eslint config; `yarn install` to prune lockfile.
10. **Local end-to-end.** Run `npm run build` then `wrangler dev` — verify SPA
    loads at `/`, deep links (`/play/1`) resolve via SPA fallback, and full game
    flow (add player → play → spin → leaderboard) hits D1 correctly.
11. **Deploy.** `wrangler d1 migrations apply hadoken-high-roller` (remote) then
    `npm run deploy`. Verify on the `*.workers.dev` URL.
12. **Docs.** Rewrite `README.md` (web instructions, no Electron).

---

## 9. Verification Checklist

- [ ] `npm run typecheck` passes for both client and worker projects.
- [ ] `npm run build` produces `dist/client` with hashed assets, sounds, symbols.
- [ ] `wrangler dev` serves SPA at `/`; deep link `/play/1` returns the SPA
      (SPA fallback), not 404.
- [ ] `POST /api/players` creates/returns a player; idempotent by name.
- [ ] `GET /api/leaderboard` returns top-10 by `highest_balance`.
- [ ] Full game flow updates `games`, `spins`, `players.total_spins`, and
      `highest_balance` exactly as the Electron version did.
- [ ] No remaining references to `electron`, `window.api`, `window.electron`,
      `better-sqlite3`, `ipcMain`, `ipcRenderer`, `BrowserWindow` (grep clean).
- [ ] Vanta/THREE background renders; sounds play; symbols load.
- [ ] `wrangler deploy` succeeds; remote D1 migrated; public URL works.

---

## 10. Risks, Trade-offs & Open Items

- **Sync → async DB.** `better-sqlite3` is synchronous; D1 is async. Every query
  function and its callers become `async/await`. Logic is unchanged but signatures
  shift. Low risk, mechanical.
- **`last_row_id` / `changes`.** D1 exposes these via `result.meta`, not
  `lastInsertRowid`/`changes`. Ensure the `start-game`/`record-spin`/`end-game`
  ports read `meta` correctly.
- **No transactions across statements by default.** The `record-spin` flow does
  insert → recompute balance → update player in 3 statements. D1 supports
  `env.DB.batch([...])` for atomicity; consider batching to match the implicit
  single-process consistency Electron had. Optional but recommended.
- **Public shared leaderboard.** With no auth, anyone can create players and post
  spins (and rewards are client-trusted). This matches the current app's design
  decision (client-side rewards, single-player). Flagged as a known trade-off; a
  future iteration could move reward calc server-side (already noted in the
  original README design notes).
- **CSP.** The Electron `default-src 'self'` CSP may need minor relaxation for the
  Vanta WebGL canvas / inline styles on the web; validate in a real browser.
- **Asset paths under BrowserRouter.** Ensure Vite `base` is `/` and asset imports
  remain absolute so deep-linked routes still resolve `/assets/*` correctly
  (handled by SPA fallback only matching non-asset paths).
- **Yarn vs npm.** Repo currently uses Yarn (Berry, `.yarnrc.yml`). The plan keeps
  Yarn unless you prefer npm; scripts above are package-manager agnostic
  (`yarn dev` / `npm run dev` both work). Decide before pruning the lockfile.
- **Data migration.** Existing `slotmachine.db` local data is **not** migrated to
  D1 (it's per-user desktop data). If any data must be preserved, add a one-off
  export/import step; otherwise D1 starts fresh with the seeded `Player 1`.

---

## 11. Effort Estimate

| Phase | Scope | Rough effort |
|---|---|---|
| Worker + D1 scaffold, schema | `wrangler.toml`, migration, config | 0.5 day |
| Port 5 handlers to D1, routes | `db.ts`, `index.ts` | 0.5–1 day |
| Client API + swap call sites | `client.ts`, `Play.tsx`, `PlayersList.tsx` | 0.5 day |
| Router + web build wiring | `App.tsx`, `vite.config.ts`, `index.html`, tsconfig | 0.5 day |
| Remove Electron, deps, lint, README | cleanup | 0.5 day |
| Test + deploy | local e2e, Wrangler deploy | 0.5 day |
| **Total** | | **~3 days** |

---

## 12. Gaps Found in Verification

A line-by-line re-read of every referenced source/config file (across multiple
verification passes) surfaced the following items that the earlier sections did not
fully account for. These are now incorporated above where relevant; this section is
the authoritative list of the additional work. Items §12.1–12.7 came from the
second pass; §12.8–12.14 from a third pass that inspected the remaining components
and tooling files; §12.15 lists confirmed-correct items.

### 12.1 ⚠ Router-state dependency breaks under `BrowserRouter` (correctness bug)

`Play.tsx:152` reads the player name from router state:

```ts
const { playerName } = useLocation().state as { playerName: string }
```

It is supplied only by `PlayersList.tsx:95`
(`navigate('/play/:id', { state: { playerName } })`). With `MemoryRouter` this was
fine, but under **`BrowserRouter` a hard refresh or a shared/deep link to
`/play/123` has `location.state === null`**, so this line throws
(`Cannot destructure ... of null`) and the game screen crashes.

**Required fix (pick one):**
- **(a) Tolerate missing state:** `const playerName = (useLocation().state as { playerName?: string } | null)?.playerName ?? ''` and render a sensible fallback (e.g. just "Player vs Computer"), **and/or**
- **(b) Add a backend lookup:** expose `GET /api/players/:id` in the Worker and have `Play.tsx` fetch the name when state is absent (more work; restores the displayed name on refresh).

This is the single most important item missed by the initial plan and **must** be
handled as part of the router swap, not deferred.

### 12.2 `Splash.tsx` import removal (not just the render)

`Splash.tsx` has **both** `import Versions from './Versions'` (line 3) and
`<Versions />` (line 50). Deleting only the render leaves a dangling import to a
deleted file → build/typecheck failure. Remove both. (Reflected in §6.)

### 12.3 `LeaderboardEntry` is duplicated, not imported

`PlayersList.tsx:6–11` declares its **own** local `LeaderboardEntry` interface
(it does not import from `preload/index.d.ts`). After migration, repoint this to
the shared type in `src/shared` / `src/worker/types.ts` (or leave the local copy,
but document the duplication). The original §6 implied a single shared type.

### 12.4 ESLint config is tightly coupled to electron-toolkit

`eslint.config.mjs:1–2,7,30` use `@electron-toolkit/eslint-config-ts` as the
`tseslint.config(...)` wrapper **and** `@electron-toolkit/eslint-config-prettier`.
Removing those packages means the whole file must be rewritten against
`typescript-eslint` directly (the `tseslint.config()` helper and
`tseslint.configs.recommended` come from there). The existing react / react-hooks /
react-refresh plugins and the `prettier` config equivalent
(`eslint-config-prettier`) can be reused. Budget real time for this; it is not a
one-line swap.

### 12.5 Network-failure UX (new failure mode vs local IPC)

All `window.api.*` calls were effectively-synchronous in-process IPC that almost
never failed. As `fetch` over the network they can now time out / 5xx / go offline.
Current handlers only `console.error` (e.g. `Play.tsx:191,214,250,331,353,411`;
`PlayersList.tsx:38`). At minimum:
- The typed `fetch` client (§5.6) must throw on non-2xx so existing `try/catch`
  blocks still trigger.
- Consider user-visible retry/error states for `startGame` (the game cannot begin
  if `gameId` never resolves) and `getLeaderboard` (already routes to `Error`
  component via `Home.tsx:11`, which is good — preserve that path).

### 12.6 Cosmetic / naming leftovers (optional, low priority)

- `Home.tsx` component is named `DatabaseTest` and `setMessage` strings say
  "Database connected successfully!" / "Test complete" — desktop-test phrasing.
  Optional cleanup for a public web app.
- `AddPlayer.tsx:16` defaults the input to `'TestPlayer'`. Optional: default to
  empty string for the web.
- These do not block migration but are worth a pass during the README/UX cleanup.

### 12.7 Toolchain / environment specifics

- **Yarn Berry:** `.yarnrc.yml` + `.yarn/` indicate Yarn 3/4 (Berry), not classic
  Yarn. **Confirmed:** `.yarnrc.yml` already sets `nodeLinker: node-modules` (not
  PnP), so Wrangler resolves normally — no PnP workaround needed for this repo.
  `.yarn/install-state.gz` is the only `.yarn/` artifact (no PnP cache).
- **Node/compat:** Add a `compatibility_flags = ["nodejs_compat"]` line to
  `wrangler.toml` **only if** any Worker code needs Node built-ins. The ported
  `db.ts` uses pure D1 + Web APIs, so it should **not** be required — confirm during
  step 4 rather than adding it pre-emptively.
- **`.dev.vars` / local D1:** `wrangler d1 ... --local` stores a local SQLite under
  `.wrangler/` (already added to `.gitignore` in §7.4). No secrets are needed for
  this app (no auth), so `.dev.vars` is likely empty — listed for completeness only.

### 12.8 `tsconfig.web.json` includes the preload `.d.ts` (build breaks on delete)

`tsconfig.web.json:7` explicitly lists `"src/preload/*.d.ts"` in `include`. Section
4 deletes `src/preload/`, so the renamed `tsconfig.client.json` **must drop that
include entry** (and instead pull `Player`/`LeaderboardEntry` from
`src/shared` or `src/worker/types.ts`). Without this, `tsc` errors on a missing
include path. (Augments §7.2.)

### 12.9 `symbols.ts` imports have NO `?url` — and the resolved value is persisted to the DB

`symbols.ts:1–16` imports the 16 PNGs **without** the `?url` suffix
(unlike `Logo.tsx`/sound files which use `?url`). Under Vite these still resolve to
a hashed asset URL string at build time, so `streetFighterSymbols` is an array of
URL strings. Two consequences the plan must note:

- **Functionally fine on web** — Vite handles bare PNG imports as URLs; the slot
  reels and `calculateReward` (which only compares string equality) keep working.
- **DB data caveat:** `Play.tsx:329` does `randomSymbols.join(',')` and stores
  those **build-hashed URLs** in `spins.symbols` (e.g. `/assets/ryu-a1b2c3.png`).
  Because the hash changes on every rebuild/redeploy, historical `spins.symbols`
  values become stale references over time. This was already true in Electron, but
  is more visible on the web (deploys are frequent). **Recommendation:** store a
  stable identifier (character name/index) instead of the URL in `spins.symbols`.
  Low priority — only matters if spin history is ever displayed; the leaderboard
  does not read `symbols`. Flag, don't block.

### 12.10 `.vscode/` and editor configs

`.vscode/` contains `launch.json`, `extensions.json`, `settings.json` — the
`launch.json` is the electron-vite debug configuration and will reference Electron
main/renderer debug targets. Remove or rewrite `launch.json` for a web/Wrangler
workflow (e.g. a Chrome launch + `wrangler dev`); `extensions.json`/`settings.json`
(ESLint+Prettier) can stay. `.editorconfig` and `.prettierrc.yaml` are
tooling-agnostic and unchanged.

### 12.11 `.prettierignore` rename coverage

`.prettierignore` ignores `tsconfig.json` and `tsconfig.*.json`. The renamed
`tsconfig.client.json` / `tsconfig.worker.json` are still matched by the
`tsconfig.*.json` glob, so no change is strictly required — noted so the rename in
§7.2 isn't assumed to need a prettierignore edit. It also still lists
`pnpm-lock.yaml` (repo uses Yarn) — harmless leftover, optional cleanup.

### 12.12 Favicon / app icon salvage

`build/` contains real `icon.png` / `icon.ico` / `icon.icns` and `resources/icon.png`
is a real 36 KB PNG. §4 deletes both dirs. Before deleting, **copy one PNG to serve
as the web favicon** (e.g. `src/client/assets/favicon.png` or `public/favicon.ico`)
and add a `<link rel="icon">` to the root `index.html` (§5.8). Otherwise the web app
ships with no favicon. (Augments §4's "verify contents first" note with a concrete
action.)

### 12.13 `out/` exists and is stale build output

`out/main` and `out/preload` exist on disk (electron-vite output). It is gitignored
but present locally; delete it during cleanup (§4 already lists `out/`). The new web
build targets `dist/client`, so `out/` becomes dead. No code references it after
`package.json` `"main"` is removed (§7.1).

### 12.14 `Player.balance` phantom field is consumed by the type, not just declared

`preload/index.d.ts:7` declares `balance: number` on `Player`, but no such column
exists (confirmed in schema). The Worker's `getOrCreatePlayer` returns
`SELECT *`, which will **not** include `balance`. No current renderer code reads
`player.balance` (verified — `PlayersList` uses `highest_balance`/`total_spins`
only), so dropping the field from the shared `Player` type (as §5.3 says) is safe
and will not break consumers. Confirmed, not just assumed.

### 12.15 Verified-correct items (no change needed)

For completeness, these were re-checked and the plan handles them correctly:
- Sound/logo `?url` and icon `?asset` imports are Vite-native and port as-is
  (note `symbols.ts` uses bare imports — see §12.9).
- `calculateReward` and `getWinningSymbolIndices` are pure and stay client-side.
- The 5 IPC handlers map cleanly to the 5 REST endpoints; all validation preserved.
- DB schema ports 1:1 to D1; `journal_mode = WAL` correctly dropped.
- No `electron-store` usage anywhere (confirmed).
- `Versions.tsx` is the only consumer of `window.electron`; safe to delete.
- `GameOver.tsx`, `Logo.tsx`, `RetroButton.tsx`, `SlotMachine.tsx`, `SlotReel.tsx`,
  `SpinButton.tsx`, `CoinCounter.tsx`, `RewardModal.tsx`, `Error.tsx`,
  `AddPlayer.tsx` re-checked: pure / prop-driven, no Electron or `window.api`
  usage — they port unchanged.
- `Yarn` `.yarnrc.yml` already sets `nodeLinker: node-modules` (not PnP), so the
  Wrangler PnP concern in §12.7 does **not** apply to this repo — Wrangler will
  resolve normally. (Confirmed.)

---

## Verdict

**The plan is complete and ready to execute** once §12 is treated as part of it.

Three verification passes were performed against every source/config file in the
repo. The architecture, file inventory (delete/create/modify), D1 schema port,
IPC→REST mapping, dependency changes, build wiring, and deployment steps are all
**correct**.

Findings, by severity:

- **Must-fix before it works (1):** §12.1 — `BrowserRouter` router-state crash in
  `Play.tsx` on refresh/deep-link. This is a real runtime bug, not a style nit.
- **Build/typecheck failures if ignored (3):** §12.2 (dangling `Versions` import),
  §12.4 (ESLint config rewrite), §12.8 (`tsconfig` includes deleted preload `.d.ts`).
- **Correctness/UX/data caveats (4):** §12.3 (duplicated type), §12.5 (network
  failure UX), §12.9 (build-hashed symbol URLs persisted to `spins.symbols`),
  §12.12 (favicon salvage).
- **Cleanup/cosmetic (rest):** §12.6, §12.7, §12.10, §12.11, §12.13, §12.14.
- **Confirmed correct (no action):** §12.15, including that all 17 components
  except `Versions.tsx` port unchanged, the `Player.balance` phantom field is
  unused so safe to drop, and Yarn uses `node-modules` linker (no PnP/Wrangler
  issue).

No further gaps were found in the third pass beyond those now documented in §12.
Revised effort estimate: **~3–3.5 days**, the extra half-day covering the
router-state fix and the ESLint rewrite (the other items are minor or cleanup).
