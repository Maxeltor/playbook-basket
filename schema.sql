-- Playbook Basket — base de données D1 (SQLite)

-- Comptes. role : 'admin' (tout), 'editor' (modifie les équipes auxquelles il est rattaché),
-- 'reader' (consulte seulement les équipes auxquelles il est rattaché).
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash  TEXT NOT NULL,              -- PBKDF2-SHA256 (hex)
  salt       TEXT NOT NULL,              -- sel aléatoire (hex)
  role       TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'reader')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code TEXT                              -- code d'équipe : permet à un compte de rejoindre l'équipe
);

-- Rattachement d'un compte (éditeur ou lecteur) à une équipe. Les admins n'en ont pas besoin.
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, team_id)
);

-- Sessions de connexion (seul le hash du jeton est stocké).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Une ligne par système enregistré dans la bibliothèque d'une équipe.
CREATE TABLE IF NOT EXISTS systems (
  team_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,              -- nom du système (unique dans l'équipe)
  data       TEXT NOT NULL,              -- système complet au format JSON (voir app.js)
  phases     INTEGER NOT NULL,           -- nombre de phases (affiché dans la liste)
  updated_at INTEGER NOT NULL,           -- date de dernière modification (ms)
  updated_by TEXT NOT NULL DEFAULT '',   -- identifiant de l'auteur de la modification
  PRIMARY KEY (team_id, name)
);
