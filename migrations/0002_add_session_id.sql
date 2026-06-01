ALTER TABLE players ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_players_session ON players (session_id);
