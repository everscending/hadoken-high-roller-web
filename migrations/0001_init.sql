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

CREATE INDEX IF NOT EXISTS idx_players_highest ON players (highest_balance DESC);

INSERT INTO players (name)
SELECT 'Player 1'
WHERE NOT EXISTS (SELECT 1 FROM players);
