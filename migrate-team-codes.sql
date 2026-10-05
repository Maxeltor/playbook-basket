-- Migration : codes d'équipe (à lancer une fois sur une base existante).
--   npx wrangler d1 execute playbook-basket --remote --file=migrate-team-codes.sql
-- Les équipes existantes reçoivent un code provisoire ; un éditeur peut le régénérer dans l'application.
ALTER TABLE teams ADD COLUMN code TEXT;
UPDATE teams SET code = upper(hex(randomblob(4))) WHERE code IS NULL;
