/* =============================================================
 * Playbook Basket — encodeur GIF animé (sans dépendance)
 * -------------------------------------------------------------
 * Utilisé par app.js pour « Exporter en GIF ».
 *
 *   const palette = buildGifPalette([imageData, ...]);   // 256 couleurs communes à toutes les images
 *   const gif = createGifWriter(largeur, hauteur, palette);
 *   gif.addFrame(imageData, délaiEnCentièmesDeSeconde);  // autant de fois que d'images
 *   const blob = gif.finish();                           // Blob « image/gif »
 *
 * Les images du jeu ont peu de couleurs unies : palette globale
 * (découpe médiane sur 5 bits par canal) et compression LZW standard.
 * ============================================================= */
'use strict';

const GIF_BIN_BITS = 5;                       // précision des couleurs : 5 bits par canal
const GIF_BINS = 1 << (3 * GIF_BIN_BITS);
const gifBin = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Palette de 256 couleurs (768 octets RVB) pour un ensemble d'images (ImageData). */
function buildGifPalette(images) {
  const counts = new Uint32Array(GIF_BINS);
  for (const { data } of images) {
    for (let i = 0; i < data.length; i += 4) counts[gifBin(data[i], data[i + 1], data[i + 2])]++;
  }
  const used = [];
  for (let bin = 0; bin < GIF_BINS; bin++) if (counts[bin]) used.push(bin);

  const channel = (bin, c) => (bin >> (10 - 5 * c)) & 31;   // 0 = rouge, 1 = vert, 2 = bleu
  const total = bins => bins.reduce((sum, bin) => sum + counts[bin], 0);

  // Découpe médiane : on coupe toujours la boîte la plus peuplée (qui a plusieurs couleurs)
  const boxes = [used];
  while (boxes.length < 256) {
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length > 1 && (best < 0 || total(boxes[i]) > total(boxes[best]))) best = i;
    }
    if (best < 0) break;

    const box = boxes[best];
    let widest = 0, widestRange = -1;
    for (let c = 0; c < 3; c++) {
      let min = 31, max = 0;
      for (const bin of box) { const v = channel(bin, c); if (v < min) min = v; if (v > max) max = v; }
      if (max - min > widestRange) { widestRange = max - min; widest = c; }
    }
    box.sort((a, b) => channel(a, widest) - channel(b, widest));

    let half = total(box) / 2, cut = 0;
    for (; cut < box.length - 1; cut++) {
      half -= counts[box[cut]];
      if (half <= 0) break;
    }
    cut = Math.min(cut, box.length - 2);       // les deux moitiés doivent rester non vides
    boxes.splice(best, 1, box.slice(0, cut + 1), box.slice(cut + 1));
  }

  const palette = new Uint8Array(768);
  boxes.forEach((box, i) => {
    const weight = total(box) || 1;
    for (let c = 0; c < 3; c++) {
      const mean = box.reduce((sum, bin) => sum + channel(bin, c) * counts[bin], 0) / weight;
      palette[i * 3 + c] = Math.min(255, Math.round(mean * 8 + 4));
    }
  });
  return palette;
}

/** Compression LZW d'un GIF : retourne les octets déjà découpés en blocs de 255 (terminateur inclus). */
function gifLzw(indices) {
  const MIN_CODE_SIZE = 8;
  const CLEAR = 1 << MIN_CODE_SIZE, END = CLEAR + 1;
  const HASH_SIZE = 9001;                      // > 2 × 4096, table à adressage ouvert
  const keys = new Int32Array(HASH_SIZE).fill(-1);
  const values = new Int16Array(HASH_SIZE);

  const out = [];
  let block = [];
  let bitBuffer = 0, bitCount = 0;
  let codeSize = MIN_CODE_SIZE + 1;
  let next = END + 1;

  const pushByte = byte => {
    block.push(byte);
    if (block.length === 255) { out.push(255, ...block); block = []; }
  };
  const emit = code => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) { pushByte(bitBuffer & 255); bitBuffer >>>= 8; bitCount -= 8; }
  };

  emit(CLEAR);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    let slot = key % HASH_SIZE;
    while (keys[slot] !== -1 && keys[slot] !== key) slot = (slot + 1) % HASH_SIZE;
    if (keys[slot] === key) { prefix = values[slot]; continue; }

    emit(prefix);
    if (next === 4096) {                       // table pleine : on repart de zéro
      emit(CLEAR);
      keys.fill(-1);
      next = END + 1;
      codeSize = MIN_CODE_SIZE + 1;
    } else {
      if (next >= (1 << codeSize)) codeSize++;
      keys[slot] = key;
      values[slot] = next++;
    }
    prefix = k;
  }
  emit(prefix);
  emit(END);
  if (bitCount > 0) pushByte(bitBuffer & 255);
  if (block.length) out.push(block.length, ...block);
  out.push(0);
  return Uint8Array.from(out);
}

function createGifWriter(width, height, palette) {
  const le16 = n => [n & 255, n >> 8];
  const parts = [Uint8Array.from([
    ...'GIF89a'.split('').map(c => c.charCodeAt(0)),
    ...le16(width), ...le16(height), 0xF7, 0, 0,          // palette globale de 256 couleurs
    ...palette,
    0x21, 0xFF, 0x0B, ...'NETSCAPE2.0'.split('').map(c => c.charCodeAt(0)), 3, 1, 0, 0, 0,  // boucle infinie
  ])];

  // Couleur de la palette la plus proche, mémorisée par couleur à 5 bits
  const nearestCache = new Int16Array(GIF_BINS).fill(-1);
  const nearestIndex = (r, g, b) => {
    const bin = gifBin(r, g, b);
    if (nearestCache[bin] >= 0) return nearestCache[bin];
    const cr = (r & 0xF8) | 4, cg = (g & 0xF8) | 4, cb = (b & 0xF8) | 4;
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = palette[i * 3] - cr, dg = palette[i * 3 + 1] - cg, db = palette[i * 3 + 2] - cb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return (nearestCache[bin] = best);
  };

  return {
    addFrame({ data }, delayCs) {
      const indices = new Uint8Array(width * height);
      for (let p = 0, i = 0; p < indices.length; p++, i += 4) indices[p] = nearestIndex(data[i], data[i + 1], data[i + 2]);
      parts.push(
        Uint8Array.from([0x21, 0xF9, 4, 0x04, ...le16(delayCs), 0, 0,
                         0x2C, 0, 0, 0, 0, ...le16(width), ...le16(height), 0, 8]),
        gifLzw(indices));
    },
    finish: () => new Blob([...parts, Uint8Array.of(0x3B)], { type: 'image/gif' }),
  };
}
