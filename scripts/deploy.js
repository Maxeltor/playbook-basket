/* Déploiement avec numéro de version : incrémente la version (majeur.mineur.correctif) dans
 * public/version.json, y ajoute la date, puis lance « wrangler pages deploy ».
 * L'application affiche ce numéro en bas à droite.
 * Usage : npm run deploy            → 0.0.1 → 0.0.2
 *         npm run deploy -- minor   → 0.0.2 → 0.1.0
 *         npm run deploy -- major   → 0.1.0 → 1.0.0 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const file = path.join(__dirname, '..', 'public', 'version.json');
let previous = null;
let build = '0.0.0';
try {
  previous = fs.readFileSync(file, 'utf8');
  const b = JSON.parse(previous).build;
  if (typeof b === 'number') build = `0.0.${b}`;         // ancien compteur entier (v1, v2…)
  else if (/^\d+\.\d+\.\d+$/.test(b)) build = b;
} catch (e) { /* 1er déploiement */ }

const args = process.argv.slice(2);
const level = ['major', 'minor', 'patch'].includes(args[0]) ? args.shift() : 'patch';
let [major, minor, patch] = build.split('.').map(Number);
if (level === 'major') { major++; minor = 0; patch = 0; }
else if (level === 'minor') { minor++; patch = 0; }
else patch++;

const info = { build: `${major}.${minor}.${patch}`, date: new Date().toISOString() };
fs.writeFileSync(file, JSON.stringify(info) + '\n');
console.log(`Déploiement de la version v${info.build}`);

const res = spawnSync('npx', ['wrangler', 'pages', 'deploy', ...args],
  { stdio: 'inherit', shell: true, cwd: path.join(__dirname, '..') });

if (res.status !== 0) {  // échec : on n'« use » pas le numéro
  if (previous !== null) fs.writeFileSync(file, previous);
  else fs.unlinkSync(file);
  process.exit(res.status || 1);
}
