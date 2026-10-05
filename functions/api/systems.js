/* =============================================================
 * Playbook Basket — API de la bibliothèque d'équipe
 * -------------------------------------------------------------
 *   GET    /api/systems?team=ID           → [{ name, t, by, n }]  (liste, sans les données)
 *   GET    /api/systems?team=ID&name=X    → { name, t, by, d }     (un système complet)
 *   PUT    /api/systems  ← { team, name, d, baseT?, force? } → { t }
 *   DELETE /api/systems?team=ID&name=X    → { ok: true }
 *
 * Droits : lecture si le compte a accès à l'équipe, écriture pour les
 * admins et les éditeurs de l'équipe (les lecteurs reçoivent 403).
 * L'auteur (by) est toujours l'identifiant du compte connecté.
 *
 * t = date de modification (ms), by = auteur, n = nombre de phases,
 * d = système (format décrit en tête de public/app.js).
 *
 * Conflits : PUT envoie `baseT`, la date de la version que le client
 * connaît (null pour un nouveau nom). Si la version en base est
 * différente, la réponse est 409 (sauf `force: true`).
 * ============================================================= */

import { json, teamAccess } from './_middleware.js';

const MAX_NAME_LENGTH = 40;      // identique au maxlength du champ côté client
const MAX_DATA_BYTES = 200_000;  // un système fait en général quelques Ko

const isValidSystem = s => !!(s && Array.isArray(s.phases) && s.phases.length
  && s.phases[0].start && Array.isArray(s.phases[0].start.players));

const cleanName = name => (typeof name === 'string' ? name.trim() : '');

const toTeamId = v => (v === null || v === '' || v === undefined ? NaN : Number(v));

/** Équipe demandée si le compte a le droit `need` ('read' ou 'write'), sinon une réponse d'erreur. */
async function authorize({ env, data }, teamId, need) {
  const access = await teamAccess(env.DB, data.user, teamId);
  if (!access) return { error: json({ error: 'forbidden' }, 403) };
  if (need === 'write' && access !== 'write') return { error: json({ error: 'read-only' }, 403) };
  return { teamId };
}

async function findOne(db, teamId, name) {
  return db.prepare('SELECT name, data, updated_at AS t, updated_by AS by FROM systems WHERE team_id = ? AND name = ?')
    .bind(teamId, name).first();
}

/** Réponse 409 décrivant la version actuellement en base. */
async function conflict(db, teamId, name) {
  const row = await findOne(db, teamId, name);
  return json({ error: 'conflict', t: row ? row.t : null, by: row ? row.by : '' }, 409);
}

export async function onRequestGet(ctx) {
  const params = new URL(ctx.request.url).searchParams;
  const auth = await authorize(ctx, toTeamId(params.get('team')), 'read');
  if (auth.error) return auth.error;
  const name = cleanName(params.get('name'));

  if (!name) {
    const { results } = await ctx.env.DB
      .prepare('SELECT name, updated_at AS t, updated_by AS by, phases AS n FROM systems WHERE team_id = ? ORDER BY updated_at DESC')
      .bind(auth.teamId).all();
    return json(results);
  }

  const row = await findOne(ctx.env.DB, auth.teamId, name);
  if (!row) return json({ error: 'not-found' }, 404);
  return json({ name: row.name, t: row.t, by: row.by, d: JSON.parse(row.data) });
}

export async function onRequestPut(ctx) {
  let body;
  try { body = await ctx.request.json(); } catch (e) { return json({ error: 'invalid-json' }, 400); }

  const auth = await authorize(ctx, toTeamId(body.team), 'write');
  if (auth.error) return auth.error;
  const teamId = auth.teamId;

  const name = cleanName(body.name);
  if (!name || name.length > MAX_NAME_LENGTH) return json({ error: 'invalid-name' }, 400);
  if (!isValidSystem(body.d)) return json({ error: 'invalid-system' }, 400);

  const system = { ...body.d, name };
  const data = JSON.stringify(system);
  if (data.length > MAX_DATA_BYTES) return json({ error: 'too-large' }, 413);

  const by = ctx.data.user.username;
  const t = Date.now();
  const values = [data, system.phases.length, t, by];
  const db = ctx.env.DB;

  if (body.force) {
    await db.prepare(`INSERT INTO systems (team_id, name, data, phases, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (team_id, name) DO UPDATE SET data = excluded.data, phases = excluded.phases,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(teamId, name, ...values).run();
    return json({ t });
  }

  // Mise à jour seulement si la version en base est celle que le client connaît
  if (body.baseT != null) {
    const res = await db.prepare(`UPDATE systems SET data = ?, phases = ?, updated_at = ?, updated_by = ?
        WHERE team_id = ? AND name = ? AND updated_at = ?`)
      .bind(...values, teamId, name, body.baseT).run();
    if (res.meta.changes) return json({ t });
  }

  // Nouveau nom (ou système supprimé entre-temps) : création, refusée si le nom existe
  const res = await db.prepare(`INSERT INTO systems (team_id, name, data, phases, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (team_id, name) DO NOTHING`)
    .bind(teamId, name, ...values).run();
  if (res.meta.changes) return json({ t });
  return conflict(db, teamId, name);
}

export async function onRequestDelete(ctx) {
  const params = new URL(ctx.request.url).searchParams;
  const auth = await authorize(ctx, toTeamId(params.get('team')), 'write');
  if (auth.error) return auth.error;
  const name = cleanName(params.get('name'));
  if (!name) return json({ error: 'invalid-name' }, 400);
  await ctx.env.DB.prepare('DELETE FROM systems WHERE team_id = ? AND name = ?').bind(auth.teamId, name).run();
  return json({ ok: true });
}
