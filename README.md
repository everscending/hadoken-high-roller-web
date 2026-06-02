# Hadoken High Roller

A Street Fighter themed slot machine game built with React, TypeScript, and deployed to Cloudflare Workers + D1.

## Features

### Game Mechanics

- **Multi-Reel Slot Machine**: Spin 4 reels featuring 16 iconic Street Fighter characters (Ryu, Ken, Chun-Li, Blanka, Guile, Zangief, Dhalsim, E. Honda, Balrog, Vega, Sagat, M. Bison, Cammy, Fei Long, T. Hawk, and Dee Jay)
- **Coin System**: Start with 100 coins, bet 10 coins per spin
- **Reward System**:
  - **Pair** (2 matching symbols): 20 coins
  - **Three-of-a-Kind** (3 matching symbols): 50 coins
  - **Perfect Match** (all symbols match): 100 coins
  - Rewards accumulate (e.g., 2 pairs = 40 coins, pair + three-of-a-kind = 70 coins)
- **Auto-Spin**: Enable continuous automatic spinning until you run out of coins or manually stop
- **Game Over**: When coins drop below the bet amount, the game ends with a special game over screen

### Player Management

- **Add Players**: Create new players with custom names
- **Leaderboard**: View top 10 players by highest balance
- **Player Persistence**: All data stored in Cloudflare D1

### Game Features

- **Sound Effects**: Authentic Street Fighter sound effects
- **Visual Feedback**: Animated slot reels, winning symbol highlights, reward modals
- **Retro UI**: Street Fighter aesthetic with Vanta.js animated background

## Prerequisites

- **Node.js**: Version 18 or higher
- **Yarn**: Package manager (install via `npm install -g yarn`)
- **Wrangler**: Cloudflare Workers CLI (installed automatically via `yarn install`)

## Getting Started

### 1. Install Dependencies

```bash
yarn
```

### 2. Set Up D1 Database

Create a new D1 database:

```bash
yarn db:create
```

This will output a `database_id`. Copy it and paste into `wrangler.toml` to replace the placeholder.

Apply migrations locally:

```bash
yarn db:migrate:local
```

### 3. Start Development

Terminal 1 — Cloudflare Worker + D1:
```bash
yarn dev:worker
```

Terminal 2 — Vite dev server (proxies `/api` to Worker):
```bash
yarn dev
```

Open `http://localhost:5173` in your browser.

### 4. Play the Game

1. **Add a Player**: Enter your name and click "Add Player"
2. **Start Playing**: Click "Play" next to your name in the leaderboard
3. **Spin**: Click "Fight!" (costs 10 coins)
4. **Auto-Spin**: Enable for continuous gameplay
5. **Restart**: Start a new game with 100 coins
6. **Quit**: Return to the home screen

## Available Scripts

| Script | Description |
|---|---|
| `yarn dev` | Start Vite dev server (proxies `/api` to local Worker) |
| `yarn dev:worker` | Start Cloudflare Worker + D1 locally |
| `yarn build` | Build the web app for production |
| `yarn preview` | Preview locally with Worker + built assets |
| `yarn deploy` | Build and deploy to Cloudflare Workers |
| `yarn db:create` | Create a new D1 database |
| `yarn db:migrate` | Apply migrations to remote D1 |
| `yarn db:migrate:local` | Apply migrations to local D1 |
| `yarn typecheck` | Run TypeScript checking (client + worker) |
| `yarn lint` | Run ESLint |
| `yarn format` | Format code with Prettier |

## Project Structure

```
├── src/
│   ├── client/              # React SPA (Vite entry)
│   │   ├── main.tsx         # App entry point
│   │   ├── App.tsx          # BrowserRouter + routes
│   │   ├── api/             # Typed fetch client
│   │   │   └── client.ts    # API calls (replaces window.api)
│   │   ├── components/      # React components
│   │   ├── assets/          # Images, sounds, styles
│   │   └── lib/             # Utility functions (symbols, rewards)
│   ├── worker/              # Cloudflare Worker
│   │   ├── index.ts         # Router + API handlers
│   │   ├── db.ts            # D1 query functions
│   │   └── types.ts         # Shared TypeScript types
├── migrations/              # D1 migration files
│   └── 0001_init.sql        # Schema + seed data
├── index.html               # Web entry point
├── vite.config.ts           # Vite configuration
├── wrangler.toml            # Cloudflare Worker config
├── tsconfig.client.json     # Client TypeScript config
└── tsconfig.worker.json     # Worker TypeScript config
```

## API Endpoints

| Method | Path | Handler | Description |
|---|---|---|---|
| `POST` | `/api/players` | `getOrCreatePlayer` | Create or get player by name |
| `GET` | `/api/players/:id` | `getPlayerById` | Get player by ID |
| `GET` | `/api/leaderboard` | `getLeaderboard` | Top 10 players by highest balance |
| `POST` | `/api/games` | `startGame` | Start a new game session |
| `POST` | `/api/games/:id/spins` | `recordSpin` | Record a spin result |
| `POST` | `/api/games/:id/end` | `endGame` | End a game session |

## Database Schema

```
players (1) ──< games (many) ──< spins (many)
```

- **players**: `player_id`, `name`, `created_at`, `highest_balance`, `total_spins`
- **games**: `game_id`, `player_id`, `start_time`, `end_time`, `starting_balance`, `ending_balance`
- **spins**: `spin_id`, `game_id`, `timestamp`, `symbols`, `bet_amount`, `win_amount`

## Deployment

1. Create the D1 database (if not already done):
   ```bash
   yarn db:create
   ```

2. Apply migrations to production:
   ```bash
   yarn db:migrate
   ```

3. Deploy the Worker:
   ```bash
   yarn deploy
   ```

The app will be live at `https://hadoken-high-roller.<your-subdomain>.workers.dev`.

## Architecture

```
Browser (React SPA, BrowserRouter)
        │  fetch('/api/...')                static assets ('/', '/assets/*')
        ▼                                          ▲
┌───────────────────────────────────────────────────────────┐
│  Cloudflare Worker (single deployment)                      │
│   • Static asset serving (Workers Assets, SPA fallback)     │
│   • Router for /api/* (hand-rolled)                         │
│   • D1 binding (env.DB) — async SQL                         │
└───────────────────────────────────────────────────────────┘
        │
        ▼
   Cloudflare D1 (players, games, spins)
```

The React SPA uses `BrowserRouter` with SPA fallback — the Worker serves `index.html` for non-API paths, enabling deep links like `/play/1`.
