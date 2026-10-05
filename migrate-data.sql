-- Migration depuis l'ancienne version (code d'équipe unique) : à lancer APRÈS
--   1. ALTER TABLE systems RENAME TO systems_old
--   2. schema.sql
-- Les anciens systèmes sont placés dans une équipe « Équipe ».
INSERT INTO systems (team_id, name, data, phases, updated_at, updated_by)
  SELECT (SELECT id FROM teams WHERE name = 'Équipe'), name, data, phases, updated_at, updated_by
  FROM systems_old;
DROP TABLE systems_old;
