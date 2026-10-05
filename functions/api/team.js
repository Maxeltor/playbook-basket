/* =============================================================
 * Playbook Basket — gestion d'une équipe par ses éditeurs
 * -------------------------------------------------------------
 *   GET  /api/team?id=ID  → { id, name, code, members: [{ id, username, role }] }
 *                           (admins et éditeurs de l'équipe seulement)
 *   POST /api/team ← { action, ... }
 *     join             { code }              rejoint l'équipe qui porte ce code (sans compte : accès invité en
 *                                            lecture seule, tant que le code ne change pas)
 *     remove-member    { team, userId }      retire un membre de l'équipe (son compte n'est pas supprimé)
 *     regenerate-code  { team }              nouveau code d'équipe (l'ancien ne fonctionne plus)
 *
 * Le code d'équipe permet à un compte existant de rejoindre l'équipe
 * (il garde son rôle, éditeur ou lecteur) et, sans compte, de la consulter. Les admins gèrent déjà tout
 * depuis /api/admin.
 * ============================================================= */

import { json, teamAccess, newTeamCode, sessionCookie, TEAM_COOKIE, SESSION_DAYS } from './_middleware.js';

const bad = error => json({ error }, 400);

/** Équipe dont l'utilisateur est éditeur (ou admin), sinon une réponse d'erreur. */
async function editableTeam(db, user, teamId) {
  const access = await teamAccess(db, user, teamId);
  if (access !== 'write') return { error: json({ error: 'forbidden' }, 403) };
  return { team: await db.prepare('SELECT id, name, code FROM teams WHERE id = ?').bind(teamId).first() };
}

export async function onRequestGet({ request, env, data }) {
  const teamId = Number(new URL(request.url).searchParams.get('id'));
  const { team, error } = await editableTeam(env.DB, data.user, teamId);
  if (error) return error;

  const { results } = await env.DB.prepare(`SELECT u.id, u.username, u.role FROM memberships m
      JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.username`).bind(teamId).all();
  return json({ ...team, members: results });
}

export async function onRequestPost({ request, env, data }) {
  let body;
  try { body = await request.json(); } catch (e) { return bad('invalid-json'); }
  const db = env.DB;
  if (body.action !== 'join' && (!data.user || data.user.id == null)) return json({ error: 'unauthorized' }, 401);

  switch (body.action) {
    case 'join': {
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      const team = code ? await db.prepare('SELECT id, name FROM teams WHERE code = ?').bind(code).first() : null;
      if (!team) return json({ error: 'invalid-code' }, 404);
      if (!data.user || data.user.id == null) {   // invité : le cookie porte le code
        return json({ ok: true, team, guest: true }, 200,
          { 'Set-Cookie': sessionCookie(request, code, SESSION_DAYS * 86_400, TEAM_COOKIE) });
      }
      await db.prepare('INSERT OR IGNORE INTO memberships (user_id, team_id) VALUES (?, ?)')
        .bind(data.user.id, team.id).run();
      return json({ ok: true, team });
    }

    case 'remove-member': {
      const { error } = await editableTeam(db, data.user, body.team);
      if (error) return error;
      if (!Number.isInteger(body.userId)) return bad('invalid-id');
      if (body.userId === data.user.id) return json({ error: 'self-remove' }, 409);
      await db.prepare('DELETE FROM memberships WHERE team_id = ? AND user_id = ?').bind(body.team, body.userId).run();
      return json({ ok: true });
    }

    case 'regenerate-code': {
      const { error } = await editableTeam(db, data.user, body.team);
      if (error) return error;
      const code = newTeamCode();
      await db.prepare('UPDATE teams SET code = ? WHERE id = ?').bind(code, body.team).run();
      return json({ ok: true, code });
    }

    default:
      return bad('invalid-action');
  }
}
