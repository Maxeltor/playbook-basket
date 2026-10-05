/* =============================================================
 * Playbook Basket — connexion
 * -------------------------------------------------------------
 *   POST   /api/auth  ← { username, password } → { id, username, role, teams }  (+ cookie de session)
 *   GET    /api/auth  → { id, username, role, teams }   (session en cours)
 *   DELETE /api/auth  → { ok: true }                    (déconnexion)
 *
 * Premier démarrage : si aucun compte n'existe, la connexion avec
 * ADMIN_USER (défaut « admin ») et ADMIN_PASSWORD crée le compte admin.
 * ============================================================= */

import {
  json, sameText, hashPassword, randomHex, sha256Hex, readCookie, sessionCookie,
  teamsOf, SESSION_COOKIE, SESSION_DAYS,
} from './_middleware.js';

const me = async (db, user) => ({ id: user.id, username: user.username, role: user.role, teams: await teamsOf(db, user) });

async function createAdminIfFirstLogin(env, username, password) {
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (n || !env.ADMIN_PASSWORD) return null;
  const adminName = env.ADMIN_USER || 'admin';
  if (!sameText(username.toLowerCase(), adminName.toLowerCase()) || !sameText(password, env.ADMIN_PASSWORD)) return null;

  const salt = randomHex(16);
  const passHash = await hashPassword(password, salt);
  await env.DB.prepare('INSERT INTO users (username, pass_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(adminName, passHash, salt, 'admin', Date.now()).run();
  return env.DB.prepare('SELECT id, username, role FROM users WHERE username = ?').bind(adminName).first();
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid-json' }, 400); }
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) return json({ error: 'invalid-credentials' }, 401);

  let user;
  try {
    const row = await env.DB.prepare('SELECT id, username, role, pass_hash, salt FROM users WHERE username = ?')
      .bind(username).first();
    if (row) {
      // Le hash est calculé même si le mot de passe est faux : même durée dans tous les cas
      const ok = sameText(await hashPassword(password, row.salt), row.pass_hash);
      user = ok ? row : null;
    } else {
      user = await createAdminIfFirstLogin(env, username, password);
      if (!user) await hashPassword(password, randomHex(16));
    }
  } catch (e) {
    return json({ error: 'server-config', message: 'tables absentes : lancer schema.sql' }, 500);
  }
  if (!user) return json({ error: 'invalid-credentials' }, 401);

  const token = randomHex(32);
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256Hex(token), user.id, expires),
  ]);
  return json(await me(env.DB, user), 200,
    { 'Set-Cookie': sessionCookie(request, token, SESSION_DAYS * 86_400) });
}

export async function onRequestGet({ env, data }) {
  return json(await me(env.DB, data.user));
}

export async function onRequestDelete({ request, env }) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
}
