/* =============================================================
 * Playbook Basket — administration (réservée au rôle admin)
 * -------------------------------------------------------------
 *   GET  /api/admin  → { teams: [{ id, name, editors, readers }],
 *                        users: [{ id, username, role, teamIds }] }
 *   POST /api/admin  ← { action, ... }
 *     create-team  { name }
 *     delete-team  { id }                      (supprime aussi ses systèmes)
 *     create-user  { username, password, role, teamIds }
 *     update-user  { id, role?, password?, teamIds? }
 *     delete-user  { id }
 * ============================================================= */

import { json, hashPassword, randomHex, newTeamCode } from './_middleware.js';

const ROLES = ['admin', 'editor', 'reader'];
const MAX_TEAM_NAME = 40;
const MAX_USERNAME = 30;
const MIN_PASSWORD = 8;

const str = v => (typeof v === 'string' ? v.trim() : '');
const ids = v => (Array.isArray(v) ? [...new Set(v.filter(Number.isInteger))] : []);
const bad = error => json({ error }, 400);

export async function onRequestGet({ env, data }) {
  if (data.user.role !== 'admin') return json({ error: 'forbidden' }, 403);
  const [teams, users, members] = await Promise.all([
    env.DB.prepare('SELECT id, name FROM teams ORDER BY name').all(),
    env.DB.prepare('SELECT id, username, role FROM users ORDER BY username').all(),
    env.DB.prepare('SELECT user_id, team_id FROM memberships').all(),
  ]);
  const roleOf = Object.fromEntries(users.results.map(u => [u.id, u.role]));
  const count = (teamId, role) =>
    members.results.filter(m => m.team_id === teamId && roleOf[m.user_id] === role).length;
  return json({
    teams: teams.results.map(t => ({ ...t, editors: count(t.id, 'editor'), readers: count(t.id, 'reader') })),
    users: users.results.map(u => ({
      ...u, teamIds: members.results.filter(m => m.user_id === u.id).map(m => m.team_id),
    })),
  });
}

/** Remplace les équipes d'un compte (en ignorant les équipes inexistantes). */
const setMemberships = (db, userId, teamIds) => [
  db.prepare('DELETE FROM memberships WHERE user_id = ?').bind(userId),
  ...teamIds.map(teamId => db.prepare(
    'INSERT INTO memberships (user_id, team_id) SELECT ?, id FROM teams WHERE id = ?').bind(userId, teamId)),
];

export async function onRequestPost({ request, env, data }) {
  if (data.user.role !== 'admin') return json({ error: 'forbidden' }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return bad('invalid-json'); }
  const db = env.DB;

  switch (body.action) {
    case 'create-team': {
      const name = str(body.name);
      if (!name || name.length > MAX_TEAM_NAME) return bad('invalid-name');
      const res = await db.prepare('INSERT INTO teams (name, code) VALUES (?, ?) ON CONFLICT (name) DO NOTHING').bind(name, newTeamCode()).run();
      return res.meta.changes ? json({ ok: true }) : json({ error: 'name-taken' }, 409);
    }

    case 'delete-team': {
      if (!Number.isInteger(body.id)) return bad('invalid-id');
      await db.batch([
        db.prepare('DELETE FROM systems WHERE team_id = ?').bind(body.id),
        db.prepare('DELETE FROM memberships WHERE team_id = ?').bind(body.id),
        db.prepare('DELETE FROM teams WHERE id = ?').bind(body.id),
      ]);
      return json({ ok: true });
    }

    case 'create-user': {
      const username = str(body.username);
      const password = typeof body.password === 'string' ? body.password : '';
      if (username.length < 2 || username.length > MAX_USERNAME) return bad('invalid-username');
      if (password.length < MIN_PASSWORD) return bad('weak-password');
      if (!ROLES.includes(body.role)) return bad('invalid-role');

      const salt = randomHex(16);
      const res = await db.prepare(`INSERT INTO users (username, pass_hash, salt, role, created_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (username) DO NOTHING`)
        .bind(username, await hashPassword(password, salt), salt, body.role, Date.now()).run();
      if (!res.meta.changes) return json({ error: 'name-taken' }, 409);
      const userId = res.meta.last_row_id;
      await db.batch(setMemberships(db, userId, ids(body.teamIds)));
      return json({ ok: true, id: userId });
    }

    case 'update-user': {
      if (!Number.isInteger(body.id)) return bad('invalid-id');
      const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').bind(body.id).first();
      if (!target) return json({ error: 'not-found' }, 404);

      const ops = [];
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return bad('invalid-role');
        if (target.id === data.user.id && body.role !== 'admin') return json({ error: 'self-demote' }, 409);
        ops.push(db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, target.id));
      }
      if (body.password !== undefined) {
        if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD) return bad('weak-password');
        const salt = randomHex(16);
        ops.push(
          db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?')
            .bind(await hashPassword(body.password, salt), salt, target.id),
          // Un nouveau mot de passe déconnecte le compte (sauf l'admin qui vient de le changer pour lui-même)
          ...(target.id === data.user.id ? [] : [db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id)]));
      }
      if (body.teamIds !== undefined) ops.push(...setMemberships(db, target.id, ids(body.teamIds)));
      if (ops.length) await db.batch(ops);
      return json({ ok: true });
    }

    case 'delete-user': {
      if (!Number.isInteger(body.id)) return bad('invalid-id');
      if (body.id === data.user.id) return json({ error: 'self-delete' }, 409);
      await db.batch([
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(body.id),
        db.prepare('DELETE FROM memberships WHERE user_id = ?').bind(body.id),
        db.prepare('DELETE FROM users WHERE id = ?').bind(body.id),
      ]);
      return json({ ok: true });
    }

    default:
      return bad('invalid-action');
  }
}
