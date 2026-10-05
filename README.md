# Playbook Basket

Éditeur de systèmes de jeu de basket (demi-terrain), avec bibliothèque partagée en ligne pour une équipe.

```
public/              → l'application (HTML / CSS / JS, aucune dépendance)
functions/api/       → l'API de sauvegarde (Cloudflare Pages Functions)
  _middleware.js     →   session, rôles et droits d'accès par équipe
  auth.js            →   connexion / déconnexion
  admin.js           →   équipes et comptes (réservé aux admins)
  systems.js         →   lister / lire / enregistrer / supprimer un système (par équipe)
schema.sql           → tables de la base D1 (SQLite)
migrate-data.sql     → migration depuis l'ancienne version (code d'équipe unique)
wrangler.toml        → configuration Cloudflare
```

## Comptes, équipes et rôles

Chaque personne se connecte avec un **identifiant + mot de passe**. Trois rôles :

| Rôle | Peut faire |
|------|-----------|
| **Admin** | Créer des équipes et des comptes, désigner les éditeurs/lecteurs de chaque équipe, tout lire et modifier |
| **Éditeur** | Créer / modifier / supprimer les systèmes des équipes auxquelles il est rattaché |
| **Lecteur** | Consulter et lire (animation) les systèmes de ses équipes, sans rien pouvoir modifier |

- Chaque équipe a sa propre bibliothèque de systèmes ; un compte peut appartenir à plusieurs équipes
  (liste déroulante dans « Mes systèmes »).
- L'admin gère tout depuis la section **Administration** (en bas du panneau) : créer une équipe, créer un compte,
  changer son rôle, cocher les équipes auxquelles il est rattaché, changer son mot de passe, le supprimer.
- Les droits sont vérifiés **côté serveur** : un lecteur qui bidouille son navigateur ne peut rien enregistrer.
- Chaque enregistrement mémorise l'identifiant de son auteur.
- **Conflits** : si quelqu'un a modifié un système depuis que vous l'avez ouvert, l'application
  demande confirmation avant d'écraser sa version.
- **Local** : sans API (fichier `index.html` ouvert directement, hébergement statique), la bibliothèque
  reste dans le navigateur, sans comptes, comme avant.

Premier démarrage : aucun compte n'existe. La première connexion avec `ADMIN_USER` (défaut `admin`) et
`ADMIN_PASSWORD` crée le compte administrateur ; les autres comptes se créent ensuite dans l'application.
Les mots de passe sont stockés hachés (PBKDF2-SHA256 + sel) ; la session est un cookie HttpOnly de 30 jours.

## Développement local

Prérequis : Node.js 18+.

```bash
npm install
cp .dev.vars.example .dev.vars      # puis choisir ADMIN_PASSWORD
npm run db:init:local               # crée la table dans la base locale
npm run dev                         # http://localhost:8788
```

## Mise en ligne gratuite sur Cloudflare (recommandé)

Offre gratuite : 100 000 requêtes/jour, base D1 de 5 Go, pas de mise en veille, pas de carte bancaire.

```bash
npx wrangler login
npx wrangler d1 create playbook-basket        # copier le database_id affiché dans wrangler.toml
npm run db:init                               # crée la table dans la base en ligne
npm run deploy                                # 1er déploiement : accepter la création du projet
npx wrangler pages secret put ADMIN_PASSWORD   # mot de passe du compte admin (identifiant : admin)
npm run deploy                                # redéployer pour prendre en compte le secret
```

L'application est alors disponible sur `https://playbook-basket.pages.dev` (ou un nom proche).
Connectez-vous avec `admin` + ce mot de passe, puis créez équipes et comptes dans « Administration ».
Une fois le compte admin créé (1re connexion), `ADMIN_PASSWORD` ne sert plus : changez ensuite le mot de passe
depuis l'application (🔑).

### Migrer une base existante (ancienne version avec code d'équipe)

```bash
npx wrangler d1 execute playbook-basket --remote --command "ALTER TABLE systems RENAME TO systems_old"
npx wrangler d1 execute playbook-basket --remote --file=schema.sql
npx wrangler d1 execute playbook-basket --remote --file=migrate-data.sql   # anciens systèmes → équipe « Équipe »
```
(sans `--remote` pour la base locale). L'ancien secret `TEAM_CODE` n'est plus utilisé.

Variante sans ligne de commande : pousser le dossier sur GitHub, puis dans le tableau de bord Cloudflare
*Workers & Pages → Créer → Pages → Connecter à Git* (dossier de sortie : `public`), créer la base D1
(onglet *Stockage et bases de données*), la lier au projet sous le nom `DB`, exécuter le contenu de
`schema.sql` dans sa console, et ajouter la variable secrète `ADMIN_PASSWORD` (et éventuellement `ADMIN_USER`).

## Numéro de version

`npm run deploy` incrémente la version (`public/version.json`, format `0.0.1`) avant de déployer ; l'application affiche
ce numéro (`v0.0.12`…) en bas à droite, la date de déploiement apparaît au survol. Si le numéro affiché
n'est pas le dernier annoncé par la commande, le navigateur a une version en cache (Ctrl+F5).
`npm run deploy -- minor` passe à `0.1.0`, `npm run deploy -- major` à `1.0.0`.
À utiliser à la place de `npx wrangler pages deploy`, qui ne change pas le numéro.

## Sauvegarde des données

```bash
npx wrangler d1 export playbook-basket --remote --output=sauvegarde.sql
```
