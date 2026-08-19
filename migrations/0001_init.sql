CREATE TABLE spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  spin_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  result TEXT NOT NULL,
  options_snapshot TEXT NOT NULL
);

CREATE INDEX idx_spins_session_id ON spins(session_id);
CREATE INDEX idx_spins_created_at ON spins(created_at);
