CREATE TABLE IF NOT EXISTS auth_tokens (
  token_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT NOT NULL UNIQUE,
  player_id     INTEGER NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at    TIMESTAMP NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players (player_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_token ON auth_tokens (token);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_player ON auth_tokens (player_id);
