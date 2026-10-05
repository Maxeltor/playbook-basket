/* =============================================================
 * Playbook Basket — authentification et droits de l'API (/api/*)
 * -------------------------------------------------------------
 * Chaque requête (sauf la connexion) doit porter le cookie de session
 * « pb_session » obtenu par POST /api/auth.
 *
 * Rôles :
 *   admin  → crée équipes et comptes, lit et modifie toutes les équipes
 *   editor → lit et modifie les équipes auxquelles il est rattaché
 *   reader → lit seulement les équipes auxquelles il est rattaché
 *   guest  → sans compte : lit une équipe dont il a saisi le code
 * ============================================================= */

export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

export const SESSION_COOKIE = 'pb_session';
export const TEAM_COOKIE = 'pb_team';   // invité : code de l'équipe rejointe sans compte
export const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000;  // maximum accepté par Cloudflare Workers

/** Comparaison en temps constant (ne révèle pas la longueur du préfixe correct). */
export function sameText(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));

export const randomHex = n => toHex(crypto.getRandomValues(new Uint8Array(n)));

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // sans 0/O/1/I

/** Code d'équipe : 8 caractères faciles à dicter. */
export const newTeamCode = () =>
  [...crypto.getRandomValues(new Uint8Array(8))].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

export async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS }, key, 256);
  return toHex(new Uint8Array(bits));
}

export async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

export function readCookie(request, name) {
  const match = (request.headers.get('Cookie') || '').split(';')
    .map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : '';
}

export function sessionCookie(request, value, maxAgeSeconds, name = SESSION_COOKIE) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

/**
 * Utilisateur de la requête, ou null : compte connecté, sinon invité
 * { id: null, username: '', role: 'guest', guestTeamId } qui a saisi le code d'une équipe
 * (lecture seule de cette équipe ; changer le code de l'équipe révoque l'invité).
 */
export async function currentUser(request, db) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    const user = await db.prepare(`SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`)
      .bind(await sha256Hex(token), Date.now()).first();
    if (user) return user;
  }
  const code = readCookie(request, TEAM_COOKIE);
  const team = code ? await db.prepare('SELECT id FROM teams WHERE code = ?').bind(code).first() : null;
  return team ? { id: null, username: '', role: 'guest', guestTeamId: team.id } : null;
}

/** Équipes visibles par l'utilisateur : [{ id, name }]. */
export async function teamsOf(db, user) {
  if (user.role === 'guest') {
    const { results } = await db.prepare('SELECT id, name FROM teams WHERE id = ?').bind(user.guestTeamId).all();
    return results;
  }
  const sql = user.role === 'admin'
    ? 'SELECT id, name FROM teams ORDER BY name'
    : `SELECT t.id, t.name FROM teams t JOIN memberships m ON m.team_id = t.id
         WHERE m.user_id = ? ORDER BY t.name`;
  const stmt = db.prepare(sql);
  const { results } = await (user.role === 'admin' ? stmt : stmt.bind(user.id)).all();
  return results;
}

/** Droit de l'utilisateur sur une équipe : 'write' | 'read' | null. */
export async function teamAccess(db, user, teamId) {
  if (!Number.isInteger(teamId)) return null;
  if (user.role === 'guest') return teamId === user.guestTeamId ? 'read' : null;
  if (user.role === 'admin') {
    return (await db.prepare('SELECT id FROM teams WHERE id = ?').bind(teamId).first()) ? 'write' : null;
  }
  const member = await db.prepare('SELECT 1 AS ok FROM memberships WHERE user_id = ? AND team_id = ?')
    .bind(user.id, teamId).first();
  if (!member) return null;
  return user.role === 'editor' ? 'write' : 'read';
}

export async function onRequest({ request, env, next, data }) {
  if (!env.DB) {
    return json({ error: 'server-config', message: 'base D1 non liée sous le nom « DB »' }, 500);
  }

  // Routes publiques : la connexion, et « rejoindre une équipe avec son code » (team.js vérifie le reste)
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  const isLogin = request.method === 'POST' && path === '/api/auth';
  const isJoin = request.method === 'POST' && path === '/api/team';
  if (!isLogin) {
    try {
      data.user = await currentUser(request, env.DB);
    } catch (e) {
      return json({ error: 'server-config', message: 'tables absentes : lancer schema.sql' }, 500);
    }
    if (!data.user && !isJoin) return json({ error: 'unauthorized' }, 401);
  }
  return next();
}
