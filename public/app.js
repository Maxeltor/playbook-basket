/* =============================================================
 * Playbook Basket — logique de l'application
 * -------------------------------------------------------------
 * Sommaire
 *    1. Configuration            (constantes à modifier)
 *    2. Textes de l'interface
 *    3. Utilitaires
 *    4. Références DOM
 *    5. État de l'application
 *    6. Modèle de données        (système, phases, actions)
 *    7. Sauvegarde & historique  (localStorage, annuler/rétablir)
 *    8. Calcul de l'animation
 *    9. Lignes de passe & possibilités
 *   10. Dessin SVG
 *   11. Rendu du terrain
 *   12. Barres d'outils & messages
 *   13. Interactions sur le terrain (souris / tactile)
 *   14. Boutons & contrôles
 *   15. Lecture de l'animation
 *   16. Bibliothèque « Mes systèmes »  (en ligne via l'API, sinon navigateur)
 *   17. Partage & export        (lien, JSON, GIF, vue d'un système partagé)
 *   18. Démarrage
 *
 * -------------------------------------------------------------
 * Format des données (sauvegardé et exporté en JSON).
 * Les clés courtes sont conservées pour rester compatible avec
 * les sauvegardes et exports existants.
 *
 *  system = {
 *    name?:  string,             // nom du système
 *    dur:    number,             // durée par défaut d'une phase (s)
 *    speed:  number,             // vitesse de lecture (0.5 → 2)
 *    phases: [phase, ...]        // phase 0 = placement de départ
 *  }
 *  phase = {
 *    start:   state | null,      // renseigné seulement pour la phase 0
 *    actions: [action, ...],     // au plus 1 action par joueur
 *    opts?:   [{from, to}],      // possibilités affichées en fin de phase
 *                                //   (to = id d'un attaquant ou 'shot')
 *    dur?:    number             // durée propre de la phase (s)
 *  }
 *  state  = { players: [player, ...], ball: {h, x, y} | null }
 *           // ball.h = id du porteur ; null = balle libre en (x, y)
 *  player = { id: 'a1'…'a5' | 'd1'…'d5', t: 'a' | 'd', n: 1…5, x, y }
 *  action = {
 *    k:     'move' | 'dribble' | 'pass' | 'screen',
 *    from:  id du joueur qui agit,
 *    x, y:  point d'arrivée,
 *    to?:   id du receveur (passe uniquement),
 *    segs?: [{k, x, y}, ...]     // course/dribble en plusieurs étapes
 *  }
 *
 * La position de départ d'une phase N est la position de fin de la
 * phase N-1 : seules les actions sont stockées, pas les positions.
 *
 * Coordonnées : demi-terrain de 500 × 470 unités, origine en haut
 * à gauche (ligne de fond), panier en (250, 52).
 * ============================================================= */
'use strict';


/* =============================================================
 * 1. CONFIGURATION
 * ============================================================= */

/** Clés de stockage dans le navigateur (ne pas changer sous peine de perdre les sauvegardes). */
const STORAGE_KEY = 'playbook-basket-v1';
const LIBRARY_KEY = 'playbook-library-v1';
const TEAM_ID_KEY = 'playbook-team-id';

/** Adresse de l'API en ligne (functions/api/), relative à la page. */
const API_BASE = 'api/';

const APP_NAME = 'Playbook Basket';

/** Géométrie du terrain (en unités SVG). */
const COURT = {
  width: 500,
  height: 470,
  hoop: { x: 250, y: 52 },     // centre du cercle
  threePointRadius: 237.5,     // rayon de la ligne à 3 points
  cornerThreeX: 30,            // corners : x < 30 ou x > 470 → 3 points
  metersPerUnit: 0.0305,       // conversion pour afficher les distances en mètres
};

/** Zone dans laquelle on peut déplacer/tracer (légèrement hors du terrain). */
const DRAG_BOUNDS = { minX: -30, maxX: 530, minY: -30, maxY: 500 };

/** Positions par défaut des joueurs n°1 à 5 (index 0 = n°1). */
const DEFAULT_SPOTS = {
  a: [[250, 330], [80, 230], [420, 230], [190, 150], [310, 150]],  // attaquants
  d: [[250, 298], [105, 200], [395, 200], [205, 110], [295, 110]], // défenseurs
};
const PLAYERS_PER_TEAM = 5;
/** Position de la balle ajoutée quand le meneur (a1) n'existe pas. */
const DEFAULT_LOOSE_BALL = { x: 250, y: 400 };

const DEFAULT_PHASE_DURATION = 3;  // secondes
const MAX_UNDO = 80;               // nombre d'étapes d'annulation conservées
const CONFIRM_TIMEOUT_MS = 3000;   // délai pour confirmer un « Reset » ou une suppression

/** Tailles des éléments dessinés. */
const SIZE = {
  player: 15,          // rayon d'un joueur
  selectionRing: 23,   // rayon de l'anneau de sélection
  ball: 8,             // rayon de la balle
  ballOffset: 13,      // décalage de la balle par rapport au porteur (en haut à droite)
  arrowGap: 16,        // espace entre un joueur et le début/fin de sa flèche
  stroke: 3,           // épaisseur des tracés
};

/** Rayons de détection (« zone de clic ») autour des éléments. */
const HIT = {
  player: 22,       // sélection / déplacement d'un joueur
  playerDraw: 24,   // départ d'un tracé depuis un joueur
  endpoint: 26,     // prolonger une course/dribble depuis sa pointe
  passTarget: 26,   // receveur d'une passe
  ballGrab: 16,     // attraper la balle
  ballErase: 18,    // effacer la balle
  ballSnap: 36,     // la balle relâchée s'aimante au joueur le plus proche
  laneBlock: 20,    // un défenseur à moins de cette distance bloque la ligne de passe
};

/** Longueur minimale d'un geste pour créer une action. */
const MIN_DRAG_DISTANCE = 30;

/** Découpage temporel d'une phase (u = avancement de 0 à 1). */
const TIMING = {
  movesShare: 0.55,            // si courses ET passes : courses de 0 à 55 %, passes ensuite
  optionsAppearWithPass: 0.85, // apparition des possibilités (phase avec passe)…
  optionsAppear: 0.7,          // …ou sans passe
  optionsFade: 0.15,           // durée du fondu d'apparition
  maxFrameStep: 0.1,           // pas max entre 2 images (évite les sauts après un onglet en arrière-plan)
};

/** Outils de tracé. `setup: true` = disponible dans la phase 1 (placement).
    Raccourci clavier : touches 1 à 6 dans l'ordre de la liste. */
const TOOLS = [
  { id: 'place',   label: '✥ Placer',  setup: true },
  { id: 'move',    label: '→ Course' },
  { id: 'dribble', label: '〰 Dribble' },
  { id: 'pass',    label: '┄ Passe' },
  { id: 'screen',  label: '⊥ Écran' },
  { id: 'erase',   label: '⌫ Gomme',   setup: true },
];

/** Dessin du demi-terrain (fond, lignes, panier). */
const COURT_SVG = `
  <rect x="0" y="0" width="500" height="470" fill="var(--court)"/>
  <g fill="none" stroke="var(--court-lines)" stroke-width="3">
    <path d="M190 470A60 60 0 0 1 310 470"/>
    <rect x="0" y="0" width="500" height="470"/>
    <rect x="170" y="0" width="160" height="190"/>
    <circle cx="250" cy="190" r="60"/>
    <path d="M30 0V141A237.5 237.5 0 0 0 470 141V0"/>
    <path d="M215 40H285"/>
    <path d="M210 70a40 40 0 0 0 80 0"/>
  </g>
  <circle cx="250" cy="52" r="9" fill="none" stroke="var(--ball)" stroke-width="3"/>`;
/* De haut en bas : parquet, rond central, limites, raquette,
   cercle des lancers francs, ligne à 3 pts, planche, zone restrictive, cercle. */


/* =============================================================
 * 2. TEXTES DE L'INTERFACE
 * ============================================================= */

/** Aide affichée sous le terrain selon l'outil actif. */
const HINTS = {
  place: 'Phase 1 = placement de départ, sans durée. Glisse les joueurs et la balle (elle s’aimante au joueur proche).',
  erase: 'Touche un tracé ou un joueur pour le supprimer.',
  default: 'Un seul type d’action par joueur et par phase. Course ou dribble : repars de la flèche pour ajouter une étape.',
};

const MSG = {
  inheritedPositions: 'Positions héritées de la phase précédente : trace des actions.',
  options: 'Touche une flèche pour la garder comme possibilité en fin de phase (passe ou tir). En lecture, elle s’affiche sans être jouée (vert = dégagée, rouge = défenseur sur la ligne).',
  noBallHolder: 'Aucun porteur de balle en fin de phase.',
  setupNoActions: 'Phase 1 : placement de départ. Trace les actions à partir de la phase 2.',
  rosterOnlyInSetup: 'Ajoute ou retire des joueurs depuis la phase 1.',
  needPhase: 'Ajoute une phase (＋ Phase) pour lancer l’animation.',
  invalidJson: 'JSON invalide : le système n’a pas été chargé.',
  nameRequired: 'Donne un nom au système avant de l’enregistrer.',
  libraryEmpty: 'Aucun système enregistré. Donne-lui un nom puis touche Enregistrer.',
  saved: name => `« ${name} » est enregistré.`,
  savedOnline: name => `« ${name} » est enregistré en ligne pour l’équipe.`,
  opened: name => `« ${name} » est ouvert.`,
  connected: user => `Connecté en tant que ${user}.`,
  badLogin: 'Identifiant ou mot de passe incorrect.',
  sessionExpired: 'Session expirée : reconnecte-toi.',
  forbidden: 'Tu n’as pas le droit de modifier cette équipe.',
  noTeam: isAdmin => isAdmin ? 'Aucune équipe : crées-en une dans Administration.'
                              : 'Ton compte n’est rattaché à aucune équipe : demande à un administrateur.',
  createTeamFirst: 'Aucune équipe pour le moment.',
  adminSeesAll: 'Accès à toutes les équipes',
  teamCounts: (e, r) => ` ${e} éditeur${e > 1 ? 's' : ''} · ${r} lecteur${r > 1 ? 's' : ''}`,
  userCreated: 'Compte créé.',
  passwordChanged: 'Mot de passe modifié (le compte a été déconnecté).',
  askPassword: user => `Nouveau mot de passe pour ${user} (8 caractères minimum) :`,
  confirmDeleteTeam: name => `Supprimer l’équipe « ${name} » et tous ses systèmes ?`,
  confirmDeleteUser: name => `Supprimer le compte « ${name} » ?`,
  adminErrors: {
    'name-taken': 'Ce nom est déjà utilisé.',
    'weak-password': 'Mot de passe trop court (8 caractères minimum).',
    'invalid-username': 'Identifiant invalide (2 à 30 caractères).',
    'invalid-name': 'Nom invalide (1 à 40 caractères).',
    'self-demote': 'Tu ne peux pas retirer ton propre rôle d’admin.',
    'self-delete': 'Tu ne peux pas supprimer ton propre compte.',
  },
  cloudError: 'Le serveur ne répond pas. Réessaie dans un instant.',
  serverError: detail => `Serveur mal configuré (${detail}) : systèmes enregistrés dans ce navigateur uniquement.`,
  conflict: (name, by, t) => `« ${name} » a été modifié${by ? ' par ' + by : ''} le ${formatDate(t)} entre-temps.

Écraser cette version avec la tienne ?`,
  conflictKept: name => `« ${name} » n’a pas été écrasé. Enregistre sous un autre nom ou rouvre-le.`,
  badCode: 'Code d’équipe inconnu.',
  guestJoined: name => `Tu consultes l’équipe « ${name} » sans compte (lecture seule). « Déconnexion » pour revenir à tes systèmes locaux.`,
  joined: name => `Tu as rejoint l’équipe « ${name} ».`,
  codeChanged: 'Nouveau code d’équipe créé : l’ancien ne fonctionne plus.',
  confirmRemoveMember: (user, team) => `Retirer « ${user} » de l’équipe « ${team} » ? Son compte est conservé.`,
  confirmNewCode: 'Créer un nouveau code ? L’ancien code ne fonctionnera plus.',
  teamCodeHelp: 'Un compte connecté rejoint l’équipe en saisissant ce code (« Rejoindre l’équipe »).',
  linkCopied: 'Lien copié : toute personne qui l’ouvre voit ce système dans l’application.',
  linkPrompt: 'Copie ce lien :',
  confirmReplaceDraft: 'Remplacer le système que tu étais en train d’éditer par cette copie ? (Enregistre-le d’abord dans « Mes systèmes » pour le garder.)',
  linkFailed: 'Impossible de créer le lien de partage.',
  sharedOpened: name => `Système partagé${name ? ' « ' + name + ' »' : ''} ouvert en lecture seule.`,
  sharedInvalid: 'Ce lien de partage est invalide ou incomplet.',
  gifProgress: pct => `Création du GIF… ${pct} %`,
  gifDone: 'GIF créé.',
  gifFailed: 'Impossible de créer le GIF avec ce navigateur.',
  uploadLocal: n => `⤴ Envoyer en ligne ${n} système${n > 1 ? 's' : ''} enregistré${n > 1 ? 's' : ''} dans ce navigateur`,
  uploaded: (sent, kept) => `${sent} système${sent > 1 ? 's' : ''} envoyé${sent > 1 ? 's' : ''} en ligne.`
    + (kept ? ` ${kept} non envoyé${kept > 1 ? 's' : ''} : ce nom existe déjà en ligne (ouvre-le et enregistre-le sous un autre nom).` : ''),
};

/** Pastille d'état de la bibliothèque : [texte, info-bulle]. */
const CLOUD_BADGE = {
  checking: ['…', 'Connexion au serveur…'],
  online:   ['☁ En ligne', 'Bibliothèque partagée avec l’équipe.'],
  locked:   ['💾 Local', 'Sans compte, les systèmes sont enregistrés dans ce navigateur. Connecte-toi pour accéder à ceux de ton équipe.'],
  offline:  ['💾 Local', 'Pas de serveur : les systèmes sont enregistrés dans ce navigateur uniquement.'],
};


/* =============================================================
 * 3. UTILITAIRES
 * ============================================================= */

const $ = selector => document.querySelector(selector);
const clone = obj => JSON.parse(JSON.stringify(obj));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerpPoint = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
/** Courbe d'accélération douce (départ et arrivée ralentis). */
const smoothstep = t => t * t * (3 - 2 * t);

/** Élément de `items` ({x, y}) le plus proche de `pt`, à moins de `radius` ; sinon null. */
function nearest(items, pt, radius) {
  let best = null;
  let bestDist = radius;
  for (const item of items) {
    const d = distance(item, pt);
    if (d < bestDist) { best = item; bestDist = d; }
  }
  return best;
}

/** Échappe un texte avant de l'insérer dans du HTML. */
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');

/** 75.3 → "01:15.3" */
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return String(m).padStart(2, '0') + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

/** 1733400000000 → "5 déc., 14:20" */
const formatDate = timestamp => new Date(timestamp).toLocaleString('fr-FR',
  { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });


/* =============================================================
 * 4. RÉFÉRENCES DOM  (ids définis dans index.html)
 * ============================================================= */

const dom = {
  title:          $('#title'),
  timer:          $('#timer'),
  gotoLibrary:    $('#btn-goto-library'),
  phaseTabs:      $('#phase-tabs'),
  court:          $('#court'),
  message:        $('#message'),
  toolBar:        $('#tool-bar'),
  rosterBar:      $('#roster-bar'),
  historyBar:     $('#history-bar'),
  play:           $('#btn-play'),
  speed:          $('#speed'),
  duration:       $('#duration'),
  durationValue:  $('#duration-value'),
  sameDuration:   $('#btn-same-duration'),
  totalDuration:  $('#total-duration'),
  library:        $('#library'),
  systemName:     $('#system-name'),
  save:           $('#btn-save'),
  libraryList:    $('#library-list'),
  cloudStatus:    $('#cloud-status'),
  teamForm:       $('#team-form'),
  loginUser:      $('#login-user'),
  loginPass:      $('#login-pass'),
  logout:         $('#btn-logout'),
  teamSelect:     $('#team-select'),
  admin:          $('#admin'),
  adminTeams:     $('#admin-teams'),
  adminUsers:     $('#admin-users'),
  newTeamForm:    $('#new-team-form'),
  newTeamName:    $('#new-team-name'),
  newUserForm:    $('#new-user-form'),
  newUserName:    $('#new-user-name'),
  newUserPass:    $('#new-user-pass'),
  newUserRole:    $('#new-user-role'),
  newUserTeams:   $('#new-user-teams'),
  uploadLocal:    $('#btn-upload-local'),
  exportBtn:      $('#btn-export'),
  importBtn:      $('#btn-import'),
  newSystem:      $('#btn-new'),
  json:           $('#json'),
  sharedBanner:   $('#shared-banner'),
  sharedCopy:     $('#btn-shared-copy'),
  share:          $('#btn-share'),
  exportFile:     $('#btn-export-file'),
  exportGif:      $('#btn-export-gif'),
  joinForm:       $('#join-form'),
  joinCode:       $('#join-code'),
  teamPanel:      $('#team-panel'),
  teamInfo:       $('#team-info'),
};


/* =============================================================
 * 5. ÉTAT DE L'APPLICATION
 * ============================================================= */

let system = null;              // système en cours d'édition (chargé au démarrage, voir section 17)
let currentPhase = 0;            // index de la phase affichée
let tool = 'place';              // outil actif (voir TOOLS)
let showOptions = false;         // mode « ◎ Possibilité » activé
let selectedAction = -1;         // index de l'action sélectionnée dans la phase courante
let selectedPlayerId = null;     // joueur sélectionné
let resetArmed = false;          // 1er clic sur « Reset » fait → attend confirmation
let drag = null;                 // geste en cours sur le terrain (voir section 13)
let anim = null;                 // lecture : { time, wallTime, on, done }
let lastFrameTime = 0;           // horodatage de la dernière image d'animation
let lastTabsPhase = -1;          // évite de redessiner les onglets à chaque image
let undoStack = [];              // états précédents (JSON)
let redoStack = [];              // états annulés (JSON)

let localLibrary = {};           // bibliothèque du navigateur : { nom: { t: date, d: system } }
let library = {};                // bibliothèque affichée : localLibrary, ou liste en ligne { nom: { t, by, n } }
let libraryDeleteArmed = null;   // nom du système en attente de confirmation de suppression

/** Connexion à la bibliothèque en ligne (voir section 16). */
const cloud = {
  status: 'checking',  // 'checking' | 'online' | 'locked' (connexion requise) | 'offline' (pas d'API)
  user: null,          // compte connecté : { id, username, role, teams }
  teams: [],           // équipes accessibles : [{ id, name }]
  teamId: null,        // équipe dont la bibliothèque est affichée
  busy: false,         // requête d'enregistrement / suppression en cours
  base: null,          // { name, t } : version en ligne du système ouvert (détection des conflits)
  teamInfo: null,      // { id, name, code, members } : équipe active, pour les éditeurs et admins
};
const isOnline = () => cloud.status === 'online';
let sharedView = false;          // un système ouvert depuis un lien de partage est affiché (lecture seule)
/** Consultation seulement : système partagé, ou compte « lecteur » (le serveur refuse aussi toute écriture). */
const readOnly = () => sharedView || (isOnline() && !!cloud.user && (cloud.user.role === 'reader' || cloud.user.role === 'guest'));
/** Compte éditeur ou admin avec une équipe active. */
const canManageTeam = () => !!cloud.user && (cloud.user.role === 'editor' || cloud.user.role === 'admin') && cloud.teamId != null;
let readOnlyShown = false;       // état de lecture seule actuellement appliqué à l'interface
let adminData = null;            // { teams, users } : données d'administration (compte admin)

const isPlaying = () => !!(anim && anim.on);

function clearSelection() {
  selectedAction = -1;
  selectedPlayerId = null;
}


/* =============================================================
 * 6. MODÈLE DE DONNÉES
 * ============================================================= */

const makePlayer = (team, n, x, y) => ({ id: team + n, t: team, n, x, y });

/** Nouveau système : 5 attaquants, balle au meneur, une phase vide. */
function createDefaultSystem() {
  const attackers = DEFAULT_SPOTS.a.map(([x, y], i) => makePlayer('a', i + 1, x, y));
  return {
    dur: DEFAULT_PHASE_DURATION,
    speed: 1,
    phases: [
      { start: { players: attackers, ball: { h: 'a1', x: 250, y: 330 } }, actions: [] },
      { start: null, actions: [] },
    ],
  };
}

const isValidSystem = s => !!(s && Array.isArray(s.phases) && s.phases.length
  && s.phases[0].start && Array.isArray(s.phases[0].start.players));

/**
 * Corrige les systèmes anciens ou importés :
 * - la phase 0 ne doit contenir aucune action (sinon on insère une phase de placement),
 * - un joueur n'a qu'une action par phase (on garde la dernière).
 */
function normalizeSystem(sys) {
  sys.phases.forEach(ph => { ph.actions = ph.actions || []; });

  const first = sys.phases[0];
  if (first.actions.length) {
    sys.phases.unshift({ start: first.start, actions: [] });
    first.start = null;
  }

  sys.phases.forEach(ph => {
    const seen = new Set();
    ph.actions = ph.actions.slice().reverse()
      .filter(a => !seen.has(a.from) && seen.add(a.from))
      .reverse();
  });
}

/** Positions au début de la phase i (= fin de la phase précédente). */
function phaseStart(i) {
  return i === 0 ? system.phases[0].start : phaseEnd(i - 1);
}

/** Positions à la fin de la phase i, après application de ses actions. */
function phaseEnd(i) {
  const state = clone(phaseStart(i));
  for (const action of system.phases[i].actions) {
    if (action.k === 'pass') {
      if (!state.ball) continue;
      state.ball.h = action.to ?? null;
      if (action.to == null) { state.ball.x = action.x; state.ball.y = action.y; }
    } else {
      const player = state.players.find(p => p.id === action.from);
      if (player) { player.x = action.x; player.y = action.y; }
    }
  }
  return state;
}

/** Position de la balle « en main » : légèrement décalée par rapport au joueur. */
const handPosition = p => ({ x: p.x + SIZE.ballOffset, y: p.y - SIZE.ballOffset });

/** Position affichée de la balle dans un état figé (ou null s'il n'y a pas de balle). */
function ballPosition(state) {
  const ball = state.ball;
  if (!ball) return null;
  const holder = ball.h && state.players.find(p => p.id === ball.h);
  return holder ? handPosition(holder) : { x: ball.x, y: ball.y };
}

const phaseDuration = i => (system.phases[i] && system.phases[i].dur) || system.dur || DEFAULT_PHASE_DURATION;

/** Durée totale de l'animation (la phase 0 n'a pas de durée). */
const totalDuration = () => system.phases.reduce((sum, _, i) => sum + (i ? phaseDuration(i) : 0), 0);

/** Supprime un joueur et tout ce qui le référence (actions, passes, possibilités). */
function deletePlayer(id) {
  const setup = system.phases[0].start;
  setup.players = setup.players.filter(p => p.id !== id);
  if (setup.ball && setup.ball.h === id) setup.ball.h = null;

  system.phases.forEach(ph => {
    ph.opts = (ph.opts || []).filter(o => o.from !== id && o.to !== id);
    ph.actions = ph.actions.filter(a => a.from !== id);
    ph.actions.forEach(a => { if (a.to === id) delete a.to; });
  });
  if (selectedPlayerId === id) selectedPlayerId = null;
}

/** Ajoute le premier numéro libre de l'équipe ('a' ou 'd'), à sa position par défaut. */
function addPlayer(setup, team) {
  const numbers = Array.from({ length: PLAYERS_PER_TEAM }, (_, i) => i + 1);
  const n = numbers.find(k => !setup.players.some(p => p.id === team + k));
  if (!n) return;
  const [x, y] = DEFAULT_SPOTS[team][n - 1];
  setup.players.push(makePlayer(team, n, x, y));
}

/** Ajoute la balle (au meneur a1 s'il existe). */
function addBall(setup) {
  if (setup.ball) return;
  const pg = setup.players.find(p => p.id === 'a1');
  setup.ball = pg ? { h: 'a1', x: pg.x, y: pg.y } : { h: null, ...DEFAULT_LOOSE_BALL };
}


/* =============================================================
 * 7. SAUVEGARDE & HISTORIQUE
 * ============================================================= */

function loadSystem() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isValidSystem(saved)) return saved;
  } catch (e) { /* stockage indisponible ou corrompu */ }
  return createDefaultSystem();
}

function save() {
  if (sharedView) return;  // le système partagé ne remplace pas le travail en cours
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(system)); } catch (e) { /* ignoré */ }
}

const serialize = () => JSON.stringify(system);

/** Mémorise un état pour « Annuler » (par défaut l'état actuel). */
function pushUndo(snapshot = serialize()) {
  undoStack.push(snapshot);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
}

/**
 * Applique une modification au système. L'historique n'est alimenté
 * (et la sauvegarde faite) que si quelque chose a réellement changé.
 */
function applyChange(mutate) {
  const before = serialize();
  mutate();
  if (serialize() !== before) {
    pushUndo(before);
    save();
  }
  refresh();
}

/** Restaure l'état au sommet de `source` et empile l'état actuel dans `target`. */
function restoreFrom(source, target) {
  if (!source.length) return;
  target.push(serialize());
  system = JSON.parse(source.pop());
  currentPhase = Math.min(currentPhase, system.phases.length - 1);
  if (currentPhase === 0) tool = 'place';
  clearSelection();
  anim = null;
  save();
  lastTabsPhase = -1;
  renderTitle();
  refresh();
}

const undo = () => restoreFrom(undoStack, redoStack);
const redo = () => restoreFrom(redoStack, undoStack);


/* =============================================================
 * 8. CALCUL DE L'ANIMATION
 * ============================================================= */

/** Point situé à la fraction `t` (0 → 1) de la longueur d'une ligne brisée. */
function pointAlongPath(points, t) {
  const lengths = [];
  let total = 0;
  for (let j = 1; j < points.length; j++) {
    const l = distance(points[j], points[j - 1]);
    lengths.push(l);
    total += l;
  }
  if (!lengths.length) return null;

  let remaining = t * total;
  for (let j = 0; j < lengths.length; j++) {
    if (remaining <= lengths[j] || j === lengths.length - 1) {
      const g = lengths[j] ? Math.min(1, remaining / lengths[j]) : 1;
      return lerpPoint(points[j], points[j + 1], g);
    }
    remaining -= lengths[j];
  }
  return null;
}

/**
 * Calcule une image de la phase à l'avancement u (0 → 1).
 * Déroulé : les courses/dribbles/écrans d'abord, puis les passes
 * l'une après l'autre.
 * Retourne { positionOf(id) → {x, y}, ball → {x, y} | null }.
 */
function computeFrame(start, end, phase, u) {
  const passes = phase.actions.filter(a => a.k === 'pass');
  const hasMoves = phase.actions.some(a => a.k !== 'pass');

  // Fenêtres de temps : courses sur [0, movesEnd], passes sur [passesStart, 1]
  const passesStart = hasMoves && passes.length ? TIMING.movesShare : 0;
  const movesEnd = hasMoves ? (passes.length ? TIMING.movesShare : 1) : 0;
  const moveProgress = smoothstep(movesEnd ? Math.min(1, u / movesEnd) : 1);

  function positionOf(id) {
    const from = start.players.find(p => p.id === id);
    const to = end.players.find(p => p.id === id);
    if (!from || !to) return null;

    // Course en plusieurs étapes : on suit le chemin
    const multiStep = phase.actions.find(a => a.k !== 'pass' && a.from === id && a.segs);
    if (multiStep) {
      const pos = pointAlongPath([from, ...multiStep.segs], moveProgress);
      if (pos) return pos;
    }
    return lerpPoint(from, to, moveProgress);
  }

  // Balle : suit son porteur, puis voyage pendant chaque passe
  let ball = null;
  if (start.ball) {
    let holder = start.ball.h;
    let loose = { x: start.ball.x, y: start.ball.y };
    const currentBall = () => {
      const p = holder && positionOf(holder);
      return p ? handPosition(p) : loose;
    };

    ball = currentBall();
    const slot = (1 - passesStart) / passes.length; // durée de chaque passe
    for (let k = 0; k < passes.length; k++) {
      const pass = passes[k];
      const passStart = passesStart + k * slot;
      if (u < passStart) break;

      const receiver = pass.to && positionOf(pass.to);
      const target = receiver ? handPosition(receiver) : { x: pass.x, y: pass.y };
      if (u < passStart + slot) {               // passe en cours
        ball = lerpPoint(currentBall(), target, (u - passStart) / slot);
        break;
      }
      holder = pass.to || null;                 // passe terminée
      loose = { x: pass.x, y: pass.y };
      ball = currentBall();
    }
  }

  return { positionOf, ball };
}


/* =============================================================
 * 9. LIGNES DE PASSE & POSSIBILITÉS
 * ============================================================= */

/** Valeur d'un tir depuis la position p. */
const shotValue = p =>
  distance(p, COURT.hoop) > COURT.threePointRadius
  || p.x < COURT.cornerThreeX || p.x > COURT.width - COURT.cornerThreeX ? 3 : 2;

/**
 * Lignes de passe possibles depuis le porteur, vers chaque coéquipier
 * et vers le panier (tir).
 * Retourne [{ from, target, blocked, meters, shot?, points? }].
 */
function computePassingLanes(state) {
  const ball = state.ball;
  const holder = ball && state.players.find(p => p.id === ball.h);
  if (!holder) return [];

  // Un défenseur proche du segment porteur → cible bloque la ligne
  const isBlocked = target => {
    const dx = target.x - holder.x;
    const dy = target.y - holder.y;
    const len2 = dx * dx + dy * dy || 1;
    return state.players.some(q => {
      if (q.t !== 'd') return false;
      const t = ((q.x - holder.x) * dx + (q.y - holder.y) * dy) / len2; // projection sur la ligne
      if (t <= 0 || t >= 1) return false;
      return distance({ x: holder.x + dx * t, y: holder.y + dy * t }, q) < HIT.laneBlock;
    });
  };

  const lane = target => ({
    from: holder,
    target,
    blocked: isBlocked(target),
    meters: distance(holder, target) * COURT.metersPerUnit,
  });

  const lanes = state.players
    .filter(p => p.t === 'a' && p.id !== holder.id)
    .map(lane);
  lanes.push({ ...lane({ id: 'shot', ...COURT.hoop }), shot: true, points: shotValue(holder) });
  return lanes;
}

/** Possibilités enregistrées encore valables en fin de phase (bon porteur, cible existante). */
const validOptions = (phase, end) => (phase.opts || []).filter(o =>
  end.ball && end.ball.h === o.from
  && (o.to === 'shot' || end.players.some(p => p.id === o.to && p.t === 'a')));

const laneColor = blocked => blocked ? 'var(--def)' : 'var(--lane-open)';

/** Ajoute/retire une possibilité (porteur de fin de phase → cible). */
function toggleOption(targetId) {
  const end = phaseEnd(currentPhase);
  const holder = end.ball && end.ball.h;
  if (!holder) return;
  applyChange(() => {
    const phase = system.phases[currentPhase];
    phase.opts = phase.opts || [];
    const k = phase.opts.findIndex(o => o.from === holder && o.to === targetId);
    if (k >= 0) phase.opts.splice(k, 1);
    else phase.opts.push({ from: holder, to: targetId });
  });
}


/* =============================================================
 * 10. DESSIN SVG  (chaque fonction retourne une chaîne SVG)
 * ============================================================= */

/**
 * Flèche d'une action (ou d'une étape d'action) de (x1,y1) vers (x2,y2).
 * kind  : 'move' | 'dribble' | 'pass' | 'screen'
 * index : index de l'action (-1 = aperçu pendant le tracé)
 * faded : affichage estompé (pendant la lecture)
 */
function drawActionShape(kind, x1, y1, x2, y2, index, faded, options = {}) {
  const {
    trimStart = SIZE.arrowGap, // espace laissé au départ
    trimEnd = SIZE.arrowGap,   // espace laissé à l'arrivée
    head = true,               // pointe de flèche
    hitArea = true,            // zone de clic élargie (invisible)
  } = options;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length < trimStart + trimEnd + 10) return '';

  const ux = dx / length, uy = dy / length;   // direction
  const nx = -uy, ny = ux;                    // perpendiculaire
  const sx = x1 + ux * trimStart, sy = y1 + uy * trimStart;  // début du trait
  const ex = x2 - ux * trimEnd, ey = y2 - uy * trimEnd;      // fin du trait (pointe)
  const drawnLength = length - trimStart - trimEnd;
  const headBack = head ? 8 : 0;              // le trait s'arrête avant la pointe
  const lx = ex - ux * headBack, ly = ey - uy * headBack;

  const stroke = 'stroke="var(--ink)" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  const width = `stroke-width="${SIZE.stroke}"`;
  const arrowHead = head
    ? `<polygon points="${ex},${ey} ${ex - ux * 12 + nx * 6},${ey - uy * 12 + ny * 6} ${ex - ux * 12 - nx * 6},${ey - uy * 12 - ny * 6}" fill="var(--ink)"/>`
    : '';

  let body;
  switch (kind) {
    case 'move':     // trait plein
      body = `<line x1="${sx}" y1="${sy}" x2="${lx}" y2="${ly}" ${stroke} ${width}/>` + arrowHead;
      break;

    case 'dribble': { // zigzag
      let points = `${sx},${sy}`;
      for (let t = 10, side = 1; t < drawnLength - 10; t += 10, side = -side) {
        points += ` ${sx + ux * t + nx * 6 * side},${sy + uy * t + ny * 6 * side}`;
      }
      points += ` ${lx},${ly}`;
      body = `<polyline points="${points}" ${stroke} ${width}/>` + arrowHead;
      break;
    }

    case 'pass':     // pointillés
      body = `<line x1="${sx}" y1="${sy}" x2="${lx}" y2="${ly}" ${stroke} ${width} stroke-dasharray="7 6"/>` + arrowHead;
      break;

    default:         // écran : pointillés terminés par une barre perpendiculaire
      body = `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" ${stroke} ${width} stroke-dasharray="7 6"/>`
           + `<line x1="${ex + nx * 14}" y1="${ey + ny * 14}" x2="${ex - nx * 14}" y2="${ey - ny * 14}" ${stroke} stroke-width="4"/>`;
  }

  const hit = hitArea
    ? `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="transparent" stroke-width="24"/>`
    : '';
  const isSelected = !faded && index >= 0 && index === selectedAction;
  const attrs = (index >= 0 ? ` data-action="${index}"` : '')
              + (isSelected ? ' class="is-selected"' : '');
  return `<g${attrs} opacity="${faded ? 0.25 : 1}">${body}${hit}</g>`;
}

/** Tracé complet d'une action (y compris toutes ses étapes). */
function drawAction(action, index, start, end, faded) {
  const from = start.players.find(p => p.id === action.from);
  if (!from) return '';

  if (action.k === 'pass') {
    // La passe vise la position de fin de phase du receveur
    const receiver = action.to && end.players.find(p => p.id === action.to);
    const target = receiver || action;
    return drawActionShape('pass', from.x, from.y, target.x, target.y, index, faded);
  }

  const steps = action.segs || [{ k: action.k, x: action.x, y: action.y }];
  let svg = '';
  let prev = from;
  steps.forEach((step, j) => {
    const isLast = j === steps.length - 1;
    svg += drawActionShape(step.k, prev.x, prev.y, step.x, step.y, index, faded, {
      trimStart: j ? 0 : SIZE.arrowGap,
      trimEnd: isLast ? SIZE.arrowGap : 0,
      head: isLast,
    });
    prev = step;
  });
  return svg;
}

/** Joueur : rond plein (attaquant) ou contour (défenseur) avec son numéro. */
function drawPlayer(player, x, y, ring = false) {
  const isAttacker = player.t === 'a';
  const color = isAttacker ? 'var(--att)' : 'var(--def)';
  const fill = isAttacker ? 'var(--att)' : 'var(--card)';
  const textColor = isAttacker ? 'var(--att-text)' : 'var(--def)';
  const ringSvg = ring
    ? `<circle cx="${x}" cy="${y}" r="${SIZE.selectionRing}" fill="none" stroke="var(--ball)" stroke-width="3"/>`
    : '';
  return `<g>${ringSvg}`
    + `<circle cx="${x}" cy="${y}" r="${SIZE.player}" fill="${fill}" stroke="${color}" stroke-width="3"/>`
    + `<text x="${x}" y="${y + 6}" text-anchor="middle" font-size="18" fill="${textColor}">${player.n}</text></g>`;
}

function drawBall({ x, y }) {
  const r = SIZE.ball;
  return `<!-- Fond de la balle -->
  <circle cx="${x}" cy="${y}" r="${r}" fill="var(--ball)" stroke="var(--ball-seam)" stroke-width="${r * 0.04}"/>

  <!-- Lignes et rainures proportionnelles au rayon (r) -->
  <g fill="none" stroke="var(--ball-seam)" stroke-width="${r * 0.1}" stroke-linecap="round">
    <!-- Ligne horizontale -->
    <path d="M${x - r} ${y} H${x + r}" />
    
    <!-- Ligne verticale -->
    <path d="M${x} ${y - r} V${y + r}" />
    
    <!-- Arc gauche -->
    <path d="M${x - r * 0.707} ${y - r * 0.707} A${r} ${r} 0 0 1 ${x - r * 0.707} ${y + r * 0.707}" />
    
    <!-- Arc droit -->
    <path d="M${x + r * 0.707} ${y - r * 0.707} A${r} ${r} 0 0 0 ${x + r * 0.707} ${y + r * 0.707}" />
  </g>`;
}

/** Cercles pointillés aux positions d'arrivée des joueurs qui bougent. */
function drawEndGhosts(start, end) {
  return start.players.map(p => {
    const e = end.players.find(q => q.id === p.id);
    if (!e || (e.x === p.x && e.y === p.y)) return '';
    return `<circle cx="${e.x}" cy="${e.y}" r="${SIZE.player}" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="3 3"/>`;
  }).join('');
}

/** Flèche de ligne de passe/tir, avec étiquette de distance optionnelle. */
function drawLaneArrow(a, b, { color, width, dash = '', label = '', hitId = null, opacity = 1 }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 40) return '';

  const ux = dx / length, uy = dy / length;
  const gap = SIZE.player + 2;
  const x1 = a.x + ux * gap, y1 = a.y + uy * gap;
  const x2 = b.x - ux * gap, y2 = b.y - uy * gap;

  const line = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  const head = `<polygon points="${x2},${y2} ${x2 - ux * 11 + uy * 6},${y2 - uy * 11 - ux * 6} ${x2 - ux * 11 - uy * 6},${y2 - uy * 11 + ux * 6}" fill="${color}"/>`;
  const text = label
    ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle" font-size="15" fill="${color}" stroke="var(--court)" stroke-width="4" paint-order="stroke">${label}</text>`
    : '';
  const hit = hitId
    ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="28" data-option="${hitId}"/>`
    : '';
  return `<g opacity="${opacity}">${line}${head}${text}${hit}</g>`;
}

/**
 * Possibilités en mode édition.
 * showAll = true (mode ◎) : toutes les lignes, cliquables, + joueurs en position de fin.
 * showAll = false : seulement les possibilités retenues.
 */
function drawPassingOptions(end, phase, showAll) {
  const chosen = new Set(validOptions(phase, end).map(o => o.to));
  let svg = showAll
    ? end.players.map(p => `<g opacity=".55">${drawPlayer(p, p.x, p.y)}</g>`).join('')
    : '';

  for (const lane of computePassingLanes(end)) {
    const isChosen = chosen.has(lane.target.id);
    if (!showAll && !isChosen) continue;
    svg += drawLaneArrow(lane.from, lane.target, {
      color: laneColor(lane.blocked),
      width: isChosen ? 4.5 : 2.5,
      dash: lane.blocked ? '1 7' : (isChosen ? '' : '5 5'),
      label: (lane.shot ? `Tir ${lane.points} pts · ` : '') + lane.meters.toFixed(1) + ' m',
      hitId: showAll ? lane.target.id : null,
      opacity: isChosen ? 1 : 0.5,
    });
  }
  return svg;
}

/** Possibilités pendant la lecture : apparaissent en fondu à la fin de la phase. */
function drawPlaybackOptions(phase, end, positionOf, u) {
  const hasPass = phase.actions.some(a => a.k === 'pass');
  const appearAt = hasPass ? TIMING.optionsAppearWithPass : TIMING.optionsAppear;
  const opacity = Math.min(1, (u - appearAt) / TIMING.optionsFade);
  if (opacity <= 0) return '';

  const lanes = computePassingLanes(end);
  return validOptions(phase, end).map(o => {
    const a = positionOf(o.from);
    const b = o.to === 'shot' ? COURT.hoop : positionOf(o.to);
    if (!a || !b) return '';
    const lane = lanes.find(l => l.target.id === o.to);
    const blocked = !!(lane && lane.blocked);
    return drawLaneArrow(a, b, { color: laneColor(blocked), width: 4.5, dash: blocked ? '1 7' : '', opacity });
  }).join('');
}

/** Aperçu de la flèche pendant qu'on la trace. */
function drawDragPreview(start) {
  const from = start.players.find(p => p.id === drag.from);
  if (!from) return '';
  return drag.extend
    ? drawActionShape(tool, drag.sx, drag.sy, drag.x, drag.y, -1, false, { trimStart: 0, hitArea: false })
    : drawActionShape(tool, from.x, from.y, drag.x, drag.y, -1, false, { hitArea: false });
}


/* =============================================================
 * 11. RENDU DU TERRAIN
 * ============================================================= */

/**
 * Dessin des joueurs, tracés et balle (SVG, sans le parquet).
 * Sans argument : mode édition de la phase courante.
 * Avec { phase, u } : image de lecture (phase en cours, avancement 0 → 1).
 */
function courtMarkup(playback) {
  const phaseIndex = playback ? playback.phase : currentPhase;
  const phase = system.phases[phaseIndex];
  const start = phaseStart(phaseIndex);
  const end = phaseEnd(phaseIndex);
  const { positionOf, ball } = computeFrame(start, end, phase, playback ? playback.u : 0);
  let svg = '';

  // 1. Tracés des actions (estompés pendant la lecture)
  phase.actions.forEach((action, i) => { svg += drawAction(action, i, start, end, !!playback); });

  if (playback) {
    // 2a. Possibilités qui apparaissent en fin de phase
    svg += drawPlaybackOptions(phase, end, positionOf, playback.u);
  } else {
    // 2b. Possibilités (édition) + positions d'arrivée
    if (phaseIndex > 0 && (showOptions || validOptions(phase, end).length)) {
      svg += drawPassingOptions(end, phase, showOptions);
    }
    svg += drawEndGhosts(start, end);
  }

  // 3. Flèche en cours de tracé
  if (drag && drag.mode === 'draw') svg += drawDragPreview(start);

  // 4. Joueurs (anneau = sélectionné ou cible de la balle qu'on déplace)
  start.players.forEach(p => {
    const pos = positionOf(p.id);
    const ring = (drag && drag.ring === p.id) || (!playback && selectedPlayerId === p.id);
    svg += drawPlayer(p, pos.x, pos.y, ring);
  });

  // 5. Balle
  if (ball) svg += drawBall(ball);
  return svg;
}

/** Redessine le terrain (mêmes arguments que courtMarkup). */
function render(playback) {
  const phaseIndex = playback ? playback.phase : currentPhase;
  dom.court.innerHTML = COURT_SVG + courtMarkup(playback);

  // Onglets : à chaque rendu en édition, une seule fois par phase en lecture
  if (!playback || playback.phase !== lastTabsPhase) {
    lastTabsPhase = playback ? playback.phase : -1;
    renderTabs(phaseIndex);
  }
}

/** Redessine terrain + barres d'outils. */
function refresh() {
  render();
  renderControls();
}


/* =============================================================
 * 12. BARRES D'OUTILS & MESSAGES
 * ============================================================= */

const setMessage = text => { dom.message.textContent = text; };
const renderTitle = () => { dom.title.textContent = system.name || APP_NAME; };

function renderTabs(activeIndex) {
  const tabs = system.phases.map((_, i) => {
    const label = `Phase ${i + 1} · ${i ? phaseDuration(i) + ' s' : 'départ'}`;
    return `<button type="button" class="tab${i === activeIndex ? ' is-active' : ''}" data-phase="${i}">${label}</button>`;
  }).join('');

  dom.phaseTabs.innerHTML = tabs
    + (readOnly() ? '' : '<button type="button" class="tab" data-tab-action="add">＋ Phase</button>')
    + (activeIndex > 0 && !readOnly() ? '<button type="button" class="tab" data-tab-action="delete">Supprimer</button>' : '');
}

function syncDurationControls() {
  const isSetup = currentPhase === 0;
  const d = phaseDuration(currentPhase);
  dom.duration.value = d;
  dom.durationValue.textContent = isSetup ? 'aucune' : d + ' s';
  dom.duration.disabled = isSetup || isPlaying() || readOnly();
  dom.sameDuration.disabled = isSetup || readOnly();
  dom.totalDuration.textContent = 'Total ' + totalDuration() + ' s';
}

/** Met à jour toutes les barres de boutons et le message d'aide. */
function renderControls() {
  const isSetup = currentPhase === 0;
  syncDurationControls();

  // Outils
  dom.toolBar.innerHTML = TOOLS.map((t, i) => {
    const disabled = isSetup && !t.setup;
    return `<button type="button" data-tool="${t.id}" title="Raccourci : ${i + 1}" class="${tool === t.id ? 'is-active' : ''}"${disabled ? ' disabled' : ''}>${t.label}</button>`;
  }).join('');

  // Joueurs / balle / possibilités
  const setup = system.phases[0].start;
  const count = team => setup.players.filter(p => p.t === team).length;
  dom.rosterBar.innerHTML =
      `<button type="button" data-roster="a">＋ Attaquant ${count('a')}/${PLAYERS_PER_TEAM}</button>`
    + `<button type="button" data-roster="d">＋ Défenseur ${count('d')}/${PLAYERS_PER_TEAM}</button>`
    + `<button type="button" data-roster="ball">＋ Balle</button>`
    + `<button type="button" data-roster="options" class="${showOptions ? 'is-active' : ''}"${isSetup ? ' disabled' : ''}>◎ Possibilité</button>`;

  // Historique / suppression
  const hasSelectedAction = selectedAction >= 0 && !!system.phases[currentPhase].actions[selectedAction];
  const btn = (action, label, enabled, cls = '') =>
    `<button type="button" data-history="${action}" class="${cls}"${enabled ? '' : ' disabled'}>${label}</button>`;
  dom.historyBar.innerHTML =
      btn('undo', '↶ Annuler', undoStack.length)
    + btn('redo', '↷ Rétablir', redoStack.length)
    + btn('delete-action', '🗑 Action', hasSelectedAction)
    + btn('delete-player', '🗑 Joueur', !!selectedPlayerId)
    + btn('reset', resetArmed ? 'Confirmer ?' : '⟲ Reset', true, resetArmed ? 'is-active' : '');

  dom.play.textContent = isPlaying() ? '⏸ Pause' : '▶ Lecture';

  // Message d'aide
  if (showOptions && !isSetup) {
    setMessage(computePassingLanes(phaseEnd(currentPhase)).length ? MSG.options : MSG.noBallHolder);
  } else if (!isSetup && tool === 'place') {
    setMessage(MSG.inheritedPositions);
  } else {
    setMessage(HINTS[tool] || HINTS.default);
  }
}


/* =============================================================
 * 13. INTERACTIONS SUR LE TERRAIN
 * -------------------------------------------------------------
 * `drag` décrit le geste en cours :
 *   { mode: 'player', id }                  déplacer un joueur (phase 1)
 *   { mode: 'ball', ring }                  déplacer la balle (phase 1)
 *   { mode: 'draw', from, x, y }            tracer une action depuis un joueur
 *   { mode: 'draw', extend: true, sx, sy }  prolonger une course/dribble
 * + `before` : état du système au début du geste (pour l'historique).
 * ============================================================= */

/** Coordonnées terrain du pointeur, limitées à DRAG_BOUNDS. */
function svgPoint(event) {
  const p = new DOMPoint(event.clientX, event.clientY)
    .matrixTransform(dom.court.getScreenCTM().inverse());
  return {
    x: clamp(p.x, DRAG_BOUNDS.minX, DRAG_BOUNDS.maxX),
    y: clamp(p.y, DRAG_BOUNDS.minY, DRAG_BOUNDS.maxY),
  };
}

function onPointerDown(event) {
  if (isPlaying() || readOnly()) return;
  const pt = svgPoint(event);
  const start = phaseStart(currentPhase);

  // Clic sur une flèche de possibilité (mode ◎)
  const optionEl = event.target.closest('[data-option]');
  if (optionEl && showOptions) { toggleOption(optionEl.dataset.option); return; }

  if (tool === 'erase') { eraseAt(event.target, pt, start); return; }

  // Clic sur un tracé existant → sélection
  const actionEl = event.target.closest('[data-action]');
  if (actionEl) {
    selectedAction = +actionEl.dataset.action;
    refresh();
    return;
  }

  clearSelection();
  if (currentPhase === 0 && tool !== 'place') { setMessage(MSG.setupNoActions); return; }

  dom.court.setPointerCapture(event.pointerId);
  if (tool === 'place') beginPlacement(pt, start);
  else beginDrawing(pt, start);
  refresh();
}

/** Outil « Placer » : sélection (phases 2+) ou déplacement (phase 1). */
function beginPlacement(pt, start) {
  if (currentPhase > 0) {
    const p = nearest(start.players, pt, HIT.player);
    selectedPlayerId = p ? p.id : null;
    return;
  }

  const ball = ballPosition(start);
  if (ball && distance(ball, pt) < HIT.ballGrab) {
    drag = { mode: 'ball', before: serialize() };
    return;
  }

  const p = nearest(start.players, pt, HIT.player);
  if (p) {
    selectedPlayerId = p.id;
    drag = { mode: 'player', id: p.id, before: serialize() };
  }
}

/** Outils de tracé : depuis un joueur, ou depuis la pointe d'une course/dribble. */
function beginDrawing(pt, start) {
  const p = nearest(start.players, pt, HIT.playerDraw);
  if (p) {
    selectedPlayerId = p.id;
    drag = { mode: 'draw', from: p.id, x: pt.x, y: pt.y, before: serialize() };
    return;
  }

  if (tool === 'move' || tool === 'dribble') {
    const endpoints = system.phases[currentPhase].actions
      .filter(a => a.k === tool)
      .map(a => ({ id: a.from, x: a.x, y: a.y }));
    const ep = nearest(endpoints, pt, HIT.endpoint);
    if (ep) {
      selectedPlayerId = ep.id;
      drag = { mode: 'draw', from: ep.id, extend: true, sx: ep.x, sy: ep.y, x: pt.x, y: pt.y, before: serialize() };
    }
  }
}

/** Gomme : supprime le tracé, le joueur ou la balle touché(e). */
function eraseAt(target, pt, start) {
  selectedAction = -1;
  const actionEl = target.closest('[data-action]');
  const player = !actionEl && nearest(start.players, pt, HIT.player);
  const ball = ballPosition(start);
  const onBall = !actionEl && !player && currentPhase === 0 && ball && distance(ball, pt) < HIT.ballErase;

  applyChange(() => {
    if (actionEl) system.phases[currentPhase].actions.splice(+actionEl.dataset.action, 1);
    else if (player) deletePlayer(player.id);
    else if (onBall) system.phases[0].start.ball = null;
  });
}

function onPointerMove(event) {
  if (!drag) return;
  const pt = svgPoint(event);
  const setup = system.phases[0].start;

  switch (drag.mode) {
    case 'player': {
      const p = setup.players.find(q => q.id === drag.id);
      if (p) { p.x = pt.x; p.y = pt.y; }
      break;
    }
    case 'ball': {
      Object.assign(setup.ball, { h: null, x: pt.x, y: pt.y });
      const target = nearest(setup.players, pt, HIT.ballSnap);
      drag.ring = target ? target.id : null;
      break;
    }
    default: // tracé
      drag.x = pt.x;
      drag.y = pt.y;
  }
  render();
}

function onPointerUp(event) {
  if (!drag) return;
  const pt = svgPoint(event);
  const d = drag;
  drag = null;

  if (d.mode === 'ball') {
    // La balle s'aimante au joueur le plus proche
    const setup = system.phases[0].start;
    const target = nearest(setup.players, pt, HIT.ballSnap);
    setup.ball.h = target ? target.id : null;
  } else if (d.mode === 'draw') {
    finishDrawing(d, pt);
  }
  endDrag(d);
}

/** Geste interrompu par le système (appel entrant, défilement…) : on garde l'état atteint. */
function onPointerCancel() {
  if (!drag) return;
  const d = drag;
  drag = null;
  endDrag(d);
}

/** Enregistre dans l'historique si le geste a modifié le système. */
function endDrag(d) {
  if (serialize() !== d.before) {
    pushUndo(d.before);
    save();
  }
  refresh();
}

/** Crée l'action correspondant au tracé terminé en `pt`. */
function finishDrawing(d, pt) {
  const phase = system.phases[currentPhase];

  // Prolongement d'une course/dribble : ajout d'une étape
  if (d.extend) {
    const action = phase.actions.find(a => a.from === d.from);
    if (action && distance(pt, action) > MIN_DRAG_DISTANCE) {
      action.segs = (action.segs || [{ k: action.k, x: action.x, y: action.y }])
        .concat({ k: tool, x: pt.x, y: pt.y });
      action.x = pt.x;
      action.y = pt.y;
      selectedAction = phase.actions.indexOf(action);
    }
    return;
  }

  const start = phaseStart(currentPhase);
  const from = start.players.find(p => p.id === d.from);
  if (!from || distance(pt, from) <= MIN_DRAG_DISTANCE) return;

  const action = { k: tool, from: d.from, x: pt.x, y: pt.y };

  // Passe : accroche le receveur le plus proche (position de début ou de fin de phase)
  if (tool === 'pass') {
    const end = phaseEnd(currentPhase);
    const candidates = start.players.concat(end.players).filter(p => p.id !== d.from);
    const receiver = nearest(candidates, pt, HIT.passTarget);
    if (receiver) {
      const receiverEnd = end.players.find(p => p.id === receiver.id);
      Object.assign(action, { to: receiver.id, x: receiverEnd.x, y: receiverEnd.y });
    }
  }

  // Une seule action par joueur et par phase : la nouvelle remplace l'ancienne
  phase.actions = phase.actions.filter(a => a.from !== d.from);
  phase.actions.push(action);
  selectedAction = phase.actions.length - 1;
}


/* =============================================================
 * 14. BOUTONS & CONTRÔLES
 * ============================================================= */

function onToolClick(event) {
  const btn = event.target.closest('[data-tool]');
  if (!btn) return;
  tool = btn.dataset.tool;
  renderControls();
}

function onRosterClick(event) {
  if (readOnly()) return;
  const btn = event.target.closest('[data-roster]');
  if (!btn) return;
  const kind = btn.dataset.roster;

  if (kind === 'options') {
    showOptions = !showOptions;
    refresh();
    return;
  }
  if (currentPhase > 0) { setMessage(MSG.rosterOnlyInSetup); return; }

  applyChange(() => {
    const setup = system.phases[0].start;
    if (kind === 'ball') addBall(setup);
    else addPlayer(setup, kind);
  });
}

function onTabClick(event) {
  const btn = event.target.closest('button');
  if (!btn) return;
  if (btn.dataset.tabAction && readOnly()) return;
  anim = null;  // stoppe la lecture
  clearSelection();

  const action = btn.dataset.tabAction;
  if (action === 'add') {
    pushUndo();
    system.phases.push({ start: null, actions: [] });
    currentPhase = system.phases.length - 1;
  } else if (action === 'delete') {
    if (currentPhase > 0) {
      pushUndo();
      system.phases.splice(currentPhase, 1);
      currentPhase = Math.max(0, currentPhase - 1);
    }
  } else {
    currentPhase = +btn.dataset.phase;
  }

  // Phase 1 = placement uniquement ; ailleurs on passe à un outil de tracé
  if (currentPhase === 0) tool = 'place';
  else if (tool === 'place') tool = 'move';

  save();
  lastTabsPhase = -1;
  refresh();
  dom.timer.textContent = formatTime(0);
}

function onHistoryClick(event) {
  const btn = event.target.closest('[data-history]');
  if (!btn || isPlaying() || readOnly()) return;

  switch (btn.dataset.history) {
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'reset': armOrConfirmReset(); break;
    case 'delete-action': deleteSelectedAction(); break;
    case 'delete-player': deleteSelectedPlayer(); break;
  }
}

function deleteSelectedAction() {
  if (selectedAction < 0 || !system.phases[currentPhase].actions[selectedAction]) return false;
  applyChange(() => {
    system.phases[currentPhase].actions.splice(selectedAction, 1);
    selectedAction = -1;
  });
  return true;
}

function deleteSelectedPlayer() {
  if (!selectedPlayerId) return false;
  applyChange(() => deletePlayer(selectedPlayerId));
  return true;
}

/** « Reset » : 1er clic = demande de confirmation (3 s), 2e clic = réinitialise. */
function armOrConfirmReset() {
  if (resetArmed) { resetSystem(); return; }
  resetArmed = true;
  renderControls();
  setTimeout(() => { resetArmed = false; renderControls(); }, CONFIRM_TIMEOUT_MS);
}

function resetSystem() {
  if (readOnly()) return;
  pushUndo();
  clearSelection();
  resetArmed = false;
  system = createDefaultSystem();
  currentPhase = 0;
  anim = null;
  save();
  loadIntoUI();
}

function onDurationInput() {
  if (currentPhase === 0 || isPlaying() || readOnly()) return;
  system.phases[currentPhase].dur = +dom.duration.value;
  save();
  syncDurationControls();
  renderTabs(currentPhase);
}

function applySameDuration() {
  if (currentPhase === 0 || isPlaying() || readOnly()) return;
  const d = phaseDuration(currentPhase);
  system.dur = d;
  system.phases.forEach(p => { p.dur = d; });
  save();
  syncDurationControls();
  renderTabs(currentPhase);
}

function exportJson() {
  const text = JSON.stringify(system);
  dom.json.value = text;
  dom.json.select();
  // Copie dans le presse-papiers si le navigateur l'autorise
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

function importJson() {
  if (readOnly()) return;
  try {
    const imported = JSON.parse(dom.json.value);
    if (!isValidSystem(imported)) throw new Error('format');
    pushUndo();
    system = imported;
    currentPhase = 0;
    anim = null;
    clearSelection();
    save();
    loadIntoUI();
  } catch (e) {
    setMessage(MSG.invalidJson);
  }
}

/**
 * Raccourcis clavier :
 *   Ctrl+Z (annuler), Ctrl+Y / Ctrl+Maj+Z (rétablir),
 *   Espace (lecture / pause), 1 à 6 (outils), Suppr / Retour arrière
 *   (supprime l'action sélectionnée, sinon le joueur), Échap (désélectionne).
 */
function onKeyDown(event) {
  if (event.target.matches('input, textarea, select')) return; // garder la saisie / l'annulation native des champs
  const key = event.key.toLowerCase();

  if (event.ctrlKey || event.metaKey) {
    if (isPlaying() || readOnly()) return;
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
    else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); }
    return;
  }
  if (event.altKey) return;

  if (key === ' ') {
    // Navigation au clavier (Tab) : Espace active le bouton qui a le focus
    if (event.target.matches(':focus-visible')) return;
    event.preventDefault();
    togglePlayback();
    return;
  }
  if (isPlaying() || drag || readOnly()) return;

  if (key === 'escape') {
    clearSelection();
    refresh();
  } else if (key === 'delete' || key === 'backspace') {
    if (deleteSelectedAction() || deleteSelectedPlayer()) event.preventDefault();
  } else if (/^[1-9]$/.test(key)) {
    const t = TOOLS[+key - 1];
    if (t && (currentPhase > 0 || t.setup)) { tool = t.id; renderControls(); }
  }
}


/* =============================================================
 * 15. LECTURE DE L'ANIMATION
 * ============================================================= */

function togglePlayback() {
  if (isPlaying()) {            // pause
    anim.on = false;
    renderControls();
    return;
  }
  if (system.phases.length < 2) { setMessage(MSG.needPhase); return; }

  if (!anim || anim.done) anim = { time: 0, wallTime: 0 }; // (re)démarrage depuis le début
  anim.on = true;
  anim.done = false;
  clearSelection();
  drag = null;
  renderControls();
  lastFrameTime = 0;
  requestAnimationFrame(tick);
}

/** Phase en cours et avancement u (0 → 1) dans cette phase, à l'instant `time` (s) de l'animation. */
function playbackAt(time) {
  let phase = 1;
  let elapsed = 0;
  while (phase < system.phases.length - 1 && time >= elapsed + phaseDuration(phase)) {
    elapsed += phaseDuration(phase);
    phase++;
  }
  return { phase, u: Math.min(1, (time - elapsed) / phaseDuration(phase)) };
}

/** Une image d'animation (appelée par requestAnimationFrame). */
function tick(timestamp) {
  if (!isPlaying()) return;
  if (!lastFrameTime) lastFrameTime = timestamp;
  const dt = clamp((timestamp - lastFrameTime) / 1000, 0, TIMING.maxFrameStep);
  lastFrameTime = timestamp;

  // anim.time = temps « système » (dépend de la vitesse) ; wallTime = temps réel affiché
  anim.time += dt * (system.speed || 1);
  anim.wallTime += dt;
  const total = totalDuration();
  if (anim.time >= total) {
    anim.time = total;
    anim.on = false;
    anim.done = true;
  }

  const { phase, u } = playbackAt(anim.time);
  currentPhase = phase;  // en pause, on reste sur la phase affichée
  render({ phase, u });
  dom.timer.textContent = formatTime(anim.wallTime);

  if (!anim.on) { refresh(); return; } // fin : retour à l'édition de la dernière phase
  requestAnimationFrame(tick);
}


/* =============================================================
 * 16. BIBLIOTHÈQUE « MES SYSTÈMES »
 * -------------------------------------------------------------
 * Deux modes, choisis automatiquement au démarrage :
 *  - en ligne : l'API (functions/api/) répond → connexion par compte ;
 *    chaque équipe a sa bibliothèque (admin : toutes, éditeur : modifie ses
 *    équipes, lecteur : consulte seulement) ;
 *  - local    : pas d'API (fichier ouvert directement, hébergement
 *    statique…) → bibliothèque dans le navigateur (localStorage).
 * Le système en cours d'édition reste toujours sauvegardé dans le
 * navigateur (section 7), même en ligne.
 * ============================================================= */

/** Lecture / écriture d'une valeur du navigateur, sans planter si le stockage est indisponible. */
function readStored(key) {
  try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* ignoré */ }
}

function loadLocalLibrary() {
  try { return JSON.parse(localStorage.getItem(LIBRARY_KEY)) || {}; } catch (e) { return {}; }
}

function saveLocalLibrary() {
  writeStored(LIBRARY_KEY, JSON.stringify(localLibrary));
}

/**
 * Appel à l'API. Lève une erreur avec `status` (0 = pas de réponse JSON,
 * par ex. réseau coupé ou hébergement statique sans API) et `data` (corps de la réponse).
 * `path` : 'systems' (défaut, limité à l'équipe active), 'auth', 'admin' ou 'team'.
 */
async function api(method, { path = 'systems', name, body, query } = {}) {
  const params = new URLSearchParams();
  const scoped = path === 'systems';
  if (scoped && cloud.teamId != null) params.set('team', cloud.teamId);
  if (name) params.set('name', name);
  for (const [key, value] of Object.entries(query || {})) params.set(key, value);
  const queryString = params.toString();
  const url = API_BASE + path + (queryString ? '?' + queryString : '');
  if (scoped && body) body = { ...body, team: cloud.teamId };

  const fail = (status, data = null) => Object.assign(new Error('API ' + status), { status, data });
  let res;
  try {
    res = await fetch(url, {
      method,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },  // la session voyage dans un cookie
      body: body && JSON.stringify(body),
    });
  } catch (e) {
    throw fail(0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw fail(res.status, data);
  if (data === null) throw fail(0);
  return data;
}

/** Charge la liste des systèmes de l'équipe active. */
async function loadTeamLibrary() {
  library = {};
  cloud.teamInfo = null;
  if (cloud.teamId == null) return;
  const list = await api('GET');
  library = Object.fromEntries(list.map(e => [e.name, { t: e.t, by: e.by, n: e.n }]));
  await loadTeamInfo();
}

/** Code et membres de l'équipe active (éditeurs et admins ; sans importance si l'appel échoue). */
async function loadTeamInfo() {
  cloud.teamInfo = null;
  if (!canManageTeam()) return;
  try { cloud.teamInfo = await api('GET', { path: 'team', query: { id: cloud.teamId } }); } catch (e) { /* panneau masqué */ }
}

/** Contacte le serveur : session, équipes, bibliothèque (et données d'administration) ; sinon repli local. */
async function connectCloud() {
  if (location.protocol === 'file:') { setCloudStatus('offline'); return; }
  try {
    const me = await api('GET', { path: 'auth' });
    cloud.user = me;
    cloud.teams = me.teams;
    if (!cloud.teams.some(t => t.id === cloud.teamId)) cloud.teamId = cloud.teams.length ? cloud.teams[0].id : null;
    await loadTeamLibrary();
    adminData = me.role === 'admin' ? await api('GET', { path: 'admin' }) : null;
    setCloudStatus('online');
  } catch (e) {
    cloud.user = null;
    adminData = null;
    if (e.status >= 500) setMessage(MSG.serverError((e.data && e.data.message) || 'erreur ' + e.status));
    setCloudStatus(e.status === 401 ? 'locked' : 'offline');
  }
}

function setCloudStatus(status) {
  cloud.status = status;
  if (!isOnline()) library = localLibrary;
  renderLibrary();
  renderAdmin();
  syncReadOnly();
}

/** Compte « lecteur » : l'interface passe en consultation seule (et se rétablit à la déconnexion). */
function syncReadOnly() {
  const ro = readOnly();
  document.body.classList.toggle('is-readonly', ro);
  if (ro === readOnlyShown) return;
  readOnlyShown = ro;
  if (isPlaying()) return;
  clearSelection();
  drag = null;
  lastTabsPhase = -1;
  refresh();
}

/** Erreur d'API pendant une action : session expirée → reconnexion, sinon message. */
function onCloudError(e) {
  if (e.status === 401) {
    setMessage(MSG.sessionExpired);
    cloud.user = null;
    setCloudStatus('locked');
  } else if (e.status === 403) {
    setMessage(MSG.forbidden);
  } else {
    setMessage(MSG.cloudError);
  }
}

/** Exécute une action en ligne en bloquant les doubles clics. */
async function whileBusy(task) {
  if (cloud.busy) return;
  cloud.busy = true;
  renderLibrary();
  try { await task(); } finally {
    cloud.busy = false;
    renderLibrary();
  }
}

function renderLibrary() {
  // Pastille d'état + formulaire de connexion
  const [badgeText, badgeTitle] = CLOUD_BADGE[cloud.status];
  dom.cloudStatus.textContent = !isOnline() ? badgeText
    : cloud.user.role === 'guest' ? '☁ Invité · ' + (cloud.teams[0] ? cloud.teams[0].name : '')
    : `☁ ${cloud.user.username} · ${ROLE_LABEL[cloud.user.role]}`;
  dom.cloudStatus.title = badgeTitle;
  dom.cloudStatus.classList.toggle('is-online', isOnline());
  dom.teamForm.hidden = cloud.status !== 'locked';
  dom.logout.hidden = !isOnline();

  // Choix de l'équipe
  dom.teamSelect.hidden = !(isOnline() && cloud.teams.length);
  dom.teamSelect.disabled = cloud.busy;
  dom.teamSelect.innerHTML = cloud.teams.map(t =>
    `<option value="${t.id}"${t.id === cloud.teamId ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('');

  // Envoi des systèmes du navigateur vers la bibliothèque en ligne
  const localCount = Object.keys(localLibrary).length;
  dom.uploadLocal.hidden = !(isOnline() && localCount && cloud.teamId != null);
  dom.uploadLocal.textContent = MSG.uploadLocal(localCount);

  // Code d'équipe : possible sans compte, ou pour un compte connecté (un invité change d'équipe en se déconnectant)
  dom.joinForm.hidden = !(cloud.status === 'locked' || (isOnline() && cloud.user.role !== 'guest'));
  dom.joinCode.disabled = cloud.busy;
  renderTeamPanel();

  const typedName = dom.systemName.value.trim();
  dom.save.textContent = library[typedName] ? 'Mettre à jour' : 'Enregistrer';
  dom.save.disabled = dom.uploadLocal.disabled = cloud.busy;

  const names = Object.keys(library).sort((a, b) => library[b].t - library[a].t); // plus récent d'abord
  if (!names.length) {
    const noTeam = isOnline() && cloud.teamId == null;
    dom.libraryList.innerHTML = `<p class="muted">${noTeam ? MSG.noTeam(cloud.user.role === 'admin') : MSG.libraryEmpty}</p>`;
    return;
  }

  dom.libraryList.innerHTML = names.map(name => {
    const entry = library[name];
    const count = entry.n ?? entry.d.phases.length;
    const author = entry.by ? ' · ' + escapeHtml(entry.by) : '';
    const armed = libraryDeleteArmed === name;
    const safe = escapeHtml(name);
    const disabled = cloud.busy ? ' disabled' : '';
    return `<div class="library-item${name === system.name ? ' is-current' : ''}">
        <div><b>${safe}</b><small>${count} phase${count > 1 ? 's' : ''} · ${formatDate(entry.t)}${author}</small></div>
        <div class="library-actions">
          <button type="button" data-open="${safe}"${disabled}>Ouvrir</button>
          ${readOnly() ? '' : `<button type="button" data-delete="${safe}" class="${armed ? 'is-active' : ''}"${disabled}>${armed ? 'Confirmer ?' : '🗑'}</button>`}
        </div>
      </div>`;
  }).join('');
}

/** Panneau « Gérer l'équipe » : code d'équipe et membres (éditeurs et admins). */
function renderTeamPanel() {
  const info = cloud.teamInfo;
  const show = isOnline() && canManageTeam() && !!info && info.id === cloud.teamId;
  dom.teamPanel.hidden = !show;
  if (!show) return;

  const disabled = cloud.busy ? ' disabled' : '';
  const members = info.members.map(m => {
    const self = m.id === cloud.user.id;
    return `<div class="admin-row" data-member="${m.id}">
        <div class="admin-row-head">
          <div><b>${escapeHtml(m.username)}${self ? ' (toi)' : ''}</b><small>${ROLE_LABEL[m.role]}</small></div>
          ${self ? '' : `<button type="button" data-member-remove title="Retirer de l’équipe"${disabled}>Retirer</button>`}
        </div>
      </div>`;
  }).join('') || '<p class="muted">Aucun membre.</p>';

  dom.teamInfo.innerHTML =
    `<p>Code d’équipe : <span class="team-code">${escapeHtml(info.code || '—')}</span>
       <button type="button" data-team-code${disabled}>Nouveau code</button></p>
     <p class="muted">${MSG.teamCodeHelp}</p>${members}`;
}

/** Enregistre le système courant sous le nom saisi (en ligne si possible). */
function saveToLibrary() {
  if (readOnly()) return;
  if (isOnline() && cloud.teamId == null) { setMessage(MSG.noTeam(cloud.user.role === 'admin')); return; }
  const name = dom.systemName.value.trim();
  if (!name) {
    setMessage(MSG.nameRequired);
    dom.systemName.focus();
    return;
  }

  const finish = message => {
    system.name = name;
    save();
    renderTitle();
    renderLibrary();
    setMessage(message);
  };

  if (!isOnline()) {
    localLibrary[name] = { t: Date.now(), d: { ...clone(system), name } };
    saveLocalLibrary();
    finish(MSG.saved(name));
    return;
  }

  // Version de référence : celle qu'on a ouverte, sinon celle affichée dans la liste
  const baseT = cloud.base && cloud.base.name === name ? cloud.base.t
              : library[name] ? library[name].t : null;

  whileBusy(async () => {
    const put = force => api('PUT', { body: { name, d: system, baseT, force } });
    let result;
    try {
      result = await put(false);
    } catch (e) {
      if (e.status !== 409) { onCloudError(e); return; }
      // Quelqu'un a modifié ce système entre-temps
      if (!confirm(MSG.conflict(name, e.data.by, e.data.t))) { setMessage(MSG.conflictKept(name)); return; }
      try { result = await put(true); } catch (e2) { onCloudError(e2); return; }
    }
    library[name] = { t: result.t, by: cloud.user.username, n: system.phases.length };
    cloud.base = { name, t: result.t };
    finish(MSG.savedOnline(name));
  });
}

function openFromLibrary(name) {
  if (!library[name]) return;

  const load = (data, base) => {
    endSharedView();
    pushUndo();
    system = clone(data);
    system.name = name;
    cloud.base = base;
    currentPhase = 0;
    anim = null;
    clearSelection();
    save();
    loadIntoUI();
    setMessage(MSG.opened(name));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!isOnline()) { load(localLibrary[name].d, null); return; }

  whileBusy(async () => {
    try {
      const entry = await api('GET', { name });
      library[name] = { t: entry.t, by: entry.by, n: entry.d.phases.length };
      load(entry.d, { name, t: entry.t });
    } catch (e) {
      if (e.status === 404) { delete library[name]; return; }  // supprimé par un autre membre
      onCloudError(e);
    }
  });
}

/** Suppression en 2 clics (le 2e dans les 3 s). */
function deleteFromLibrary(name) {
  if (readOnly()) return;
  if (libraryDeleteArmed !== name) {
    libraryDeleteArmed = name;
    setTimeout(() => {
      if (libraryDeleteArmed === name) { libraryDeleteArmed = null; renderLibrary(); }
    }, CONFIRM_TIMEOUT_MS);
    renderLibrary();
    return;
  }

  libraryDeleteArmed = null;
  if (!isOnline()) {
    delete localLibrary[name];
    saveLocalLibrary();
    renderLibrary();
    return;
  }
  whileBusy(async () => {
    try {
      await api('DELETE', { name });
      delete library[name];
    } catch (e) { onCloudError(e); }
  });
}

/** Envoie les systèmes enregistrés dans le navigateur vers la bibliothèque en ligne. */
function uploadLocalLibrary() {
  if (readOnly() || cloud.teamId == null) return;
  whileBusy(async () => {
    let sent = 0, kept = 0;
    for (const [name, entry] of Object.entries(localLibrary)) {
      try {
        const { t } = await api('PUT', { body: { name, d: entry.d, baseT: null } });
        library[name] = { t, by: cloud.user.username, n: entry.d.phases.length };
        delete localLibrary[name];
        sent++;
      } catch (e) {
        if (e.status !== 409) { saveLocalLibrary(); onCloudError(e); return; }
        kept++;  // ce nom existe déjà en ligne : on garde la copie locale
      }
    }
    saveLocalLibrary();
    setMessage(MSG.uploaded(sent, kept));
  });
}

async function onLoginSubmit(event) {
  event.preventDefault();
  const username = dom.loginUser.value.trim();
  const password = dom.loginPass.value;
  cloud.status = 'checking';
  renderLibrary();
  try {
    await api('POST', { path: 'auth', body: { username, password } });
  } catch (e) {
    if (e.status === 401) setMessage(MSG.badLogin);
    else if (e.status >= 500) setMessage(MSG.serverError((e.data && e.data.message) || 'erreur ' + e.status));
    else setMessage(MSG.cloudError);
    setCloudStatus(e.status === 401 ? 'locked' : 'offline');
    return;
  }
  dom.loginPass.value = '';
  await connectCloud();
  if (isOnline()) setMessage(MSG.connected(cloud.user.username));
}

async function logout() {
  try { await api('DELETE', { path: 'auth' }); } catch (e) { /* session déjà expirée : sans importance */ }
  cloud.user = null;
  cloud.teams = [];
  cloud.base = null;
  adminData = null;
  setCloudStatus('locked');
}

/** Action sur l'équipe active (retirer un membre, nouveau code), puis rechargement du panneau. */
function teamAction(body, doneMessage) {
  return whileBusy(async () => {
    try {
      await api('POST', { path: 'team', body });
      await loadTeamInfo();
      if (doneMessage) setMessage(doneMessage);
    } catch (e) { onCloudError(e); }
  });
}

function onTeamInfoClick(event) {
  const info = cloud.teamInfo;
  if (!info) return;
  if (event.target.closest('[data-team-code]')) {
    if (confirm(MSG.confirmNewCode)) teamAction({ action: 'regenerate-code', team: info.id }, MSG.codeChanged);
    return;
  }
  const row = event.target.closest('[data-member]');
  if (!row || !event.target.closest('[data-member-remove]')) return;
  const member = info.members.find(m => m.id === +row.dataset.member);
  if (member && confirm(MSG.confirmRemoveMember(member.username, info.name))) {
    teamAction({ action: 'remove-member', team: info.id, userId: member.id });
  }
}

/** Un compte connecté rejoint une équipe grâce à son code. */
function onJoinSubmit(event) {
  event.preventDefault();
  const code = dom.joinCode.value.trim();
  return whileBusy(async () => {
    try {
      const { team, guest } = await api('POST', { path: 'team', body: { action: 'join', code } });
      dom.joinCode.value = '';
      cloud.teamId = team.id;
      writeStored(TEAM_ID_KEY, team.id);
      cloud.base = null;
      await connectCloud();
      if (isOnline()) setMessage(guest ? MSG.guestJoined(team.name) : MSG.joined(team.name));
    } catch (e) {
      if (e.status === 404) setMessage(MSG.badCode); else onCloudError(e);
    }
  });
}

/** Changement d'équipe dans la liste déroulante. */
function onTeamChange() {
  cloud.teamId = +dom.teamSelect.value;
  writeStored(TEAM_ID_KEY, cloud.teamId);
  cloud.base = null;
  libraryDeleteArmed = null;
  whileBusy(async () => {
    try { await loadTeamLibrary(); } catch (e) { onCloudError(e); }
  });
}

function onLibraryClick(event) {
  const openBtn = event.target.closest('[data-open]');
  const deleteBtn = event.target.closest('[data-delete]');
  if (openBtn) openFromLibrary(openBtn.dataset.open);
  else if (deleteBtn) deleteFromLibrary(deleteBtn.dataset.delete);
}


/* ---------- Administration (rôle admin) ---------- */

/** Rôle → libellé affiché. */
const ROLE_LABEL = { admin: 'Admin', editor: 'Éditeur', reader: 'Lecteur', guest: 'Invité' };

const teamChips = (teams, checked, attr) => teams.map(t =>
  `<label><input type="checkbox" ${attr} value="${t.id}"${checked.has(t.id) ? ' checked' : ''}> ${escapeHtml(t.name)}</label>`
).join('') || `<span class="muted">${MSG.createTeamFirst}</span>`;

function renderAdmin() {
  const show = !!(isOnline() && cloud.user.role === 'admin' && adminData);
  dom.admin.hidden = !show;
  if (!show) return;

  // Cases cochées du formulaire de création : conservées d'un rafraîchissement à l'autre
  const checkedNew = new Set([...dom.newUserTeams.querySelectorAll('input:checked')].map(i => +i.value));
  dom.newUserTeams.innerHTML = teamChips(adminData.teams, checkedNew, 'data-new-team');

  dom.adminTeams.innerHTML = adminData.teams.map(t => `<div class="admin-row" data-team="${t.id}">
      <div class="admin-row-head">
        <div><b>${escapeHtml(t.name)}</b><small>${MSG.teamCounts(t.editors, t.readers)}</small></div>
        <button type="button" data-team-delete title="Supprimer l’équipe et ses systèmes">🗑</button>
      </div>
    </div>`).join('') || `<p class="muted">${MSG.createTeamFirst}</p>`;

  dom.adminUsers.innerHTML = adminData.users.map(u => {
    const self = u.id === cloud.user.id;
    const roles = Object.entries(ROLE_LABEL).map(([value, label]) =>
      `<option value="${value}"${u.role === value ? ' selected' : ''}>${label}</option>`).join('');
    const teams = u.role === 'admin'
      ? `<small class="muted">${MSG.adminSeesAll}</small>`
      : `<div class="chips">${teamChips(adminData.teams, new Set(u.teamIds), 'data-user-team')}</div>`;
    return `<div class="admin-row" data-user="${u.id}">
        <div class="admin-row-head">
          <b>${escapeHtml(u.username)}${self ? ' (toi)' : ''}</b>
          <span class="library-actions">
            <select data-user-role aria-label="Rôle"${self ? ' disabled' : ''}>${roles}</select>
            <button type="button" data-user-password title="Changer le mot de passe">🔑</button>
            ${self ? '' : '<button type="button" data-user-delete title="Supprimer le compte">🗑</button>'}
          </span>
        </div>
        ${teams}
      </div>`;
  }).join('');
}

/** Envoie une action d'administration puis recharge tout. Retourne true si elle a réussi. */
async function adminAction(body) {
  let ok = false;
  await whileBusy(async () => {
    try {
      await api('POST', { path: 'admin', body });
      ok = true;
    } catch (e) {
      const known = e.data && MSG.adminErrors[e.data.error];
      if (known) setMessage(known); else onCloudError(e);
    }
    await connectCloud();
  });
  return ok;
}

async function onNewTeamSubmit(event) {
  event.preventDefault();
  if (await adminAction({ action: 'create-team', name: dom.newTeamName.value.trim() })) dom.newTeamName.value = '';
}

async function onNewUserSubmit(event) {
  event.preventDefault();
  const teamIds = [...dom.newUserTeams.querySelectorAll('input:checked')].map(i => +i.value);
  const ok = await adminAction({
    action: 'create-user',
    username: dom.newUserName.value.trim(),
    password: dom.newUserPass.value,
    role: dom.newUserRole.value,
    teamIds,
  });
  if (ok) {
    dom.newUserName.value = '';
    dom.newUserPass.value = '';
    setMessage(MSG.userCreated);
  }
}

function onAdminTeamsClick(event) {
  const row = event.target.closest('[data-team]');
  if (!row || !event.target.closest('[data-team-delete]')) return;
  const team = adminData.teams.find(t => t.id === +row.dataset.team);
  if (team && confirm(MSG.confirmDeleteTeam(team.name))) adminAction({ action: 'delete-team', id: team.id });
}

function onAdminUsersClick(event) {
  const row = event.target.closest('[data-user]');
  if (!row) return;
  const user = adminData.users.find(u => u.id === +row.dataset.user);
  if (!user) return;

  if (event.target.closest('[data-user-delete]')) {
    if (confirm(MSG.confirmDeleteUser(user.username))) adminAction({ action: 'delete-user', id: user.id });
  } else if (event.target.closest('[data-user-password]')) {
    const password = prompt(MSG.askPassword(user.username));
    if (password) adminAction({ action: 'update-user', id: user.id, password }).then(ok => { if (ok) setMessage(MSG.passwordChanged); });
  }
}

/** Changement de rôle ou d'équipes d'un compte (cases à cocher / liste déroulante). */
function onAdminUsersChange(event) {
  const row = event.target.closest('[data-user]');
  if (!row) return;
  const id = +row.dataset.user;
  if (event.target.matches('[data-user-role]')) {
    adminAction({ action: 'update-user', id, role: event.target.value });
  } else if (event.target.matches('[data-user-team]')) {
    const teamIds = [...row.querySelectorAll('[data-user-team]:checked')].map(i => +i.value);
    adminAction({ action: 'update-user', id, teamIds });
  }
}


/* =============================================================
 * 17. PARTAGE & EXPORT
 * -------------------------------------------------------------
 * Fonctionne sans compte ni serveur :
 *  - lien de partage : le système est contenu dans l'adresse
 *    (…/#s=…, JSON compressé). Qui ouvre le lien le voit dans
 *    l'application, en lecture seule (la lecture se lance avec ▶) ;
 *  - export JSON (fichier) et GIF animé.
 * Les données d'un lien viennent de n'importe qui : elles sont
 * reconstruites champ par champ (sanitizeSystem) avant d'être affichées.
 * ============================================================= */

const SHARE_PARAM = '#s=';
const MAX_SHARE_BYTES = 200_000;   // taille maximale du JSON d'un système partagé

/** Dimensions et cadence du GIF exporté. */
const GIF = {
  width: 480,        // px (la hauteur suit le rapport du terrain)
  fps: 24,
  maxFrames: 400,    // au-delà, la cadence baisse
  holdStart: 50,     // pause sur la première image (1/100 s)
  holdEnd: 150,      // pause sur la dernière image (1/100 s)
};
const COURT_VIEWBOX = { x: -45, y: -45, width: 590, height: 560 };   // = viewBox de #court

const toBase64Url = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/** Passe `bytes` dans un CompressionStream / DecompressionStream, en refusant plus de `limit` octets. */
async function transformBytes(bytes, transform, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { reader.cancel(); throw new Error('too-large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** Système → texte pour l'adresse : 'z' + deflate (base64url), ou 'r' + JSON brut si le navigateur ne compresse pas. */
async function encodeShare(sys) {
  const raw = new TextEncoder().encode(JSON.stringify(sys));
  if (typeof CompressionStream !== 'function') return 'r' + toBase64Url(raw);
  return 'z' + toBase64Url(await transformBytes(raw, new CompressionStream('deflate-raw'), MAX_SHARE_BYTES));
}

async function decodeShare(text) {
  const bytes = fromBase64Url(text.slice(1));
  let raw;
  if (text[0] === 'z' && typeof DecompressionStream === 'function') {
    raw = await transformBytes(bytes, new DecompressionStream('deflate-raw'), MAX_SHARE_BYTES);
  } else if (text[0] === 'r' && bytes.length <= MAX_SHARE_BYTES) {
    raw = bytes;
  } else {
    throw new Error('format');
  }
  return JSON.parse(new TextDecoder().decode(raw));
}

const PLAYER_ID = /^[ad][1-5]$/;
const ACTION_KINDS = ['move', 'dribble', 'pass', 'screen'];

/**
 * Reconstruit un système à partir de données non fiables : seuls les champs
 * connus sont copiés, avec des types et des bornes vérifiés. Retourne null si
 * les données ne forment pas un système.
 */
function sanitizeSystem(raw) {
  const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const playerId = v => (typeof v === 'string' && PLAYER_ID.test(v) ? v : null);
  const point = v => {
    if (!isObject(v) || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    return { x: clamp(v.x, DRAG_BOUNDS.minX, DRAG_BOUNDS.maxX), y: clamp(v.y, DRAG_BOUNDS.minY, DRAG_BOUNDS.maxY) };
  };
  const seconds = v => clamp(v, 0.5, 60);
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

  const cleanAction = a => {
    const from = isObject(a) && playerId(a.from);
    const pt = point(a);
    if (!from || !pt || !ACTION_KINDS.includes(a.k)) return null;
    const action = { k: a.k, from, ...pt };
    if (a.k === 'pass') {
      if (playerId(a.to)) action.to = a.to;
    } else if (Array.isArray(a.segs)) {
      const segs = list(a.segs, 20).map(sg => (isObject(sg) && ACTION_KINDS.includes(sg.k) && point(sg) ? { k: sg.k, ...point(sg) } : null));
      if (segs.length && segs.every(Boolean)) action.segs = segs;
    }
    return action;
  };

  if (!isObject(raw) || !Array.isArray(raw.phases) || !raw.phases.length || raw.phases.length > 100) return null;
  const rawStart = isObject(raw.phases[0]) && raw.phases[0].start;
  if (!isObject(rawStart) || !Array.isArray(rawStart.players)) return null;

  const players = [];
  for (const p of list(rawStart.players, 10)) {
    const id = isObject(p) && playerId(p.id);
    const pt = point(p);
    if (id && pt && !players.some(q => q.id === id)) players.push({ id, t: id[0], n: +id[1], ...pt });
  }
  let ball = null;
  if (isObject(rawStart.ball)) {
    const holder = players.find(p => p.id === rawStart.ball.h);
    const pt = point(rawStart.ball) || holder;
    if (pt) ball = { h: holder ? holder.id : null, x: pt.x, y: pt.y };
  }

  const phases = raw.phases.map((rawPhase, i) => {
    const phase = { start: i === 0 ? { players, ball } : null, actions: [] };
    if (!isObject(rawPhase)) return phase;
    phase.actions = list(rawPhase.actions, 20).map(cleanAction).filter(Boolean);
    const opts = list(rawPhase.opts, 20).map(o => {
      const from = isObject(o) && playerId(o.from);
      const to = isObject(o) && (o.to === 'shot' ? 'shot' : playerId(o.to));
      return from && to ? { from, to } : null;
    }).filter(Boolean);
    if (opts.length) phase.opts = opts;
    if (Number.isFinite(rawPhase.dur)) phase.dur = seconds(rawPhase.dur);
    return phase;
  });

  const clean = {
    dur: Number.isFinite(raw.dur) ? seconds(raw.dur) : DEFAULT_PHASE_DURATION,
    speed: Number.isFinite(raw.speed) ? clamp(raw.speed, 0.5, 2) : 1,
    phases,
  };
  if (typeof raw.name === 'string') clean.name = raw.name.trim().slice(0, 40);
  normalizeSystem(clean);
  return clean;
}

/* ---------- Système ouvert depuis un lien ---------- */

/** Affiche le système du lien (#s=…) en lecture seule, sans toucher au travail en cours. */
async function openSharedFromHash() {
  if (!location.hash.startsWith(SHARE_PARAM)) return;
  let shared = null;
  try { shared = sanitizeSystem(await decodeShare(location.hash.slice(SHARE_PARAM.length))); } catch (e) { /* lien invalide */ }
  if (!shared) { setMessage(MSG.sharedInvalid); return; }

  sharedView = true;
  system = shared;
  currentPhase = 0;
  anim = null;
  undoStack = [];
  redoStack = [];
  clearSelection();
  dom.sharedBanner.hidden = false;
  syncReadOnly();
  loadIntoUI();
  setMessage(MSG.sharedOpened(system.name));
}

/** Quitte la vue « système partagé » (le système affiché reste en mémoire). */
function endSharedView() {
  if (!sharedView) return;
  sharedView = false;
  dom.sharedBanner.hidden = true;
  if (location.hash.startsWith(SHARE_PARAM)) history.replaceState(null, '', location.pathname + location.search);
  syncReadOnly();
}

/** « Modifier une copie » : le système partagé devient le système en cours d'édition. */
function copySharedToEditor() {
  const previous = readStored(STORAGE_KEY);
  const untouched = !previous || previous === JSON.stringify(createDefaultSystem());
  if (!untouched && !confirm(MSG.confirmReplaceDraft)) return;
  endSharedView();
  save();
  loadIntoUI();
}

/* ---------- Export ---------- */

async function shareLink() {
  let url;
  try {
    url = location.href.split('#')[0] + SHARE_PARAM + await encodeShare(system);
  } catch (e) {
    setMessage(MSG.linkFailed);
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    setMessage(MSG.linkCopied);
  } catch (e) {
    prompt(MSG.linkPrompt, url);   // presse-papiers indisponible : copie manuelle
  }
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

const exportFileName = extension =>
  ((system.name || 'systeme').replace(/[^\p{L}\p{N}_ -]+/gu, '').trim().replace(/\s+/g, '-') || 'systeme') + '.' + extension;

function exportJsonFile() {
  downloadBlob(new Blob([JSON.stringify(system)], { type: 'application/json' }), exportFileName('json'));
}

/** Image de l'animation au format SVG autonome (couleurs du thème actuel, sans variables CSS). */
function frameSvg(playback) {
  const theme = getComputedStyle(document.documentElement);
  const { x, y, width, height } = COURT_VIEWBOX;
  const body = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="var(--out)"/>` + COURT_SVG + courtMarkup(playback);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${width}" height="${height}">`
    + '<style>text{font-family:Arial,Helvetica,sans-serif;font-weight:700}</style>'
    + body.replace(/var\((--[\w-]+)\)/g, (_, name) => theme.getPropertyValue(name).trim() || '#000')
    + '</svg>';
}

function rasterize(svg, ctx, width, height) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, width, height);
      resolve(ctx.getImageData(0, 0, width, height));
    };
    img.onerror = () => reject(new Error('svg'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

let gifBusy = false;

/** Génère un GIF animé du système (toutes les phases, à la vitesse choisie) et le télécharge. */
async function exportGif() {
  if (gifBusy) return;
  if (system.phases.length < 2) { setMessage(MSG.needPhase); return; }
  gifBusy = true;
  dom.exportGif.disabled = true;
  try {
    const width = GIF.width;
    const height = Math.round(width * COURT_VIEWBOX.height / COURT_VIEWBOX.width);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Instants (en temps « système ») des images : cadence fixe, plafonnée par maxFrames
    const total = totalDuration();
    const speed = system.speed || 1;
    const step = Math.max(speed / GIF.fps, total / GIF.maxFrames);
    const count = Math.ceil(total / step) + 1;
    const frameAt = i => rasterize(frameSvg(playbackAt(Math.min(total, i * step))), ctx, width, height);
    const delay = Math.max(2, Math.round(step / speed * 100));

    // Palette commune, calculée sur quelques images réparties dans l'animation
    const sampleEvery = Math.ceil(count / 8);
    const samples = [];
    for (let i = 0; i < count; i += sampleEvery) samples.push(await frameAt(i));
    samples.push(await frameAt(count - 1));
    const gif = createGifWriter(width, height, buildGifPalette(samples));

    for (let i = 0; i < count; i++) {
      gif.addFrame(await frameAt(i), delay + (i === 0 ? GIF.holdStart : 0) + (i === count - 1 ? GIF.holdEnd : 0));
      if (i % 5 === 0) setMessage(MSG.gifProgress(Math.round(100 * i / count)));
    }
    downloadBlob(gif.finish(), exportFileName('gif'));
    setMessage(MSG.gifDone);
  } catch (e) {
    setMessage(MSG.gifFailed);
  } finally {
    gifBusy = false;
    dom.exportGif.disabled = false;
  }
}


/* =============================================================
 * 18. DÉMARRAGE
 * ============================================================= */

/** (Re)synchronise toute l'interface avec `system` (au démarrage, après import / ouverture / reset). */
function loadIntoUI() {
  normalizeSystem(system);
  if (currentPhase === 0) tool = 'place';
  renderTitle();
  dom.systemName.value = system.name || '';
  renderLibrary();
  dom.speed.value = system.speed || 1;
  lastTabsPhase = -1;
  refresh();
  dom.timer.textContent = formatTime(0);
}

// Terrain
dom.court.addEventListener('pointerdown', onPointerDown);
dom.court.addEventListener('pointermove', onPointerMove);
dom.court.addEventListener('pointerup', onPointerUp);
dom.court.addEventListener('pointercancel', onPointerCancel);

// Barres d'outils
dom.phaseTabs.addEventListener('click', onTabClick);
dom.toolBar.addEventListener('click', onToolClick);
dom.rosterBar.addEventListener('click', onRosterClick);
dom.historyBar.addEventListener('click', onHistoryClick);

// Lecture & durées
dom.play.addEventListener('click', togglePlayback);
dom.speed.addEventListener('change', () => { system.speed = +dom.speed.value; save(); });
dom.duration.addEventListener('input', onDurationInput);
dom.sameDuration.addEventListener('click', applySameDuration);

// Bibliothèque, connexion, administration
dom.gotoLibrary.addEventListener('click', () => dom.library.scrollIntoView({ behavior: 'smooth' }));
dom.systemName.addEventListener('input', renderLibrary);
dom.save.addEventListener('click', () => saveToLibrary());
dom.libraryList.addEventListener('click', onLibraryClick);
dom.uploadLocal.addEventListener('click', uploadLocalLibrary);
dom.teamForm.addEventListener('submit', onLoginSubmit);
dom.logout.addEventListener('click', logout);
dom.teamSelect.addEventListener('change', onTeamChange);
dom.newTeamForm.addEventListener('submit', onNewTeamSubmit);
dom.newUserForm.addEventListener('submit', onNewUserSubmit);
dom.adminTeams.addEventListener('click', onAdminTeamsClick);
dom.adminUsers.addEventListener('click', onAdminUsersClick);
dom.adminUsers.addEventListener('change', onAdminUsersChange);
// Retour sur l'onglet : on rafraîchit la liste (modifications des autres comptes)
window.addEventListener('focus', () => { if (isOnline() && !cloud.busy) connectCloud(); });

// Équipe : code et membres
dom.joinForm.addEventListener('submit', onJoinSubmit);
dom.teamInfo.addEventListener('click', onTeamInfoClick);

// Partage et export
dom.share.addEventListener('click', shareLink);
dom.exportFile.addEventListener('click', exportJsonFile);
dom.exportGif.addEventListener('click', exportGif);
dom.sharedCopy.addEventListener('click', copySharedToEditor);
window.addEventListener('hashchange', openSharedFromHash);

// Export / import
dom.exportBtn.addEventListener('click', exportJson);
dom.importBtn.addEventListener('click', importJson);
dom.newSystem.addEventListener('click', resetSystem);

// Numéro de version affiché en bas à droite (public/version.json, mis à jour par « npm run deploy »)
fetch('version.json', { cache: 'no-store' })
  .then(res => res.ok ? res.json() : null)
  .then(v => {
    if (!v || !v.build) return;  // pas encore déployé, ou hébergement sans version
    const el = $('#app-version');
    el.textContent = 'v' + v.build;
    el.title = 'Déployée le ' + formatDate(v.date);
    el.hidden = false;
  })
  .catch(() => {});

// Clavier
document.addEventListener('keydown', onKeyDown);

system = loadSystem();
localLibrary = library = loadLocalLibrary();
cloud.teamId = +readStored(TEAM_ID_KEY) || null;
loadIntoUI();
connectCloud();
openSharedFromHash();
