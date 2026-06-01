DROP INDEX IF EXISTS idx_players_session;

ALTER TABLE players DROP COLUMN session_id;
