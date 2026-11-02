// Fonctions pures de l'OCR PaddleOCR (sans ONNX Runtime ni DOM) : testables avec Node.
//
// Pipeline (le même que dans le cours) :
//   1. Détection (DBNet) : le modèle renvoie une carte de probabilité « ici il y a du texte ».
//      On la seuille et on regroupe les pixels voisins (composantes connexes) : une composante
//      par ligne de texte.
//   2. Géométrie de chaque ligne : axe principal (ACP des pixels), puis ligne centrale estimée
//      tranche par tranche. Elle suit l'inclinaison de la photo ET la courbure de la page près de
//      la reliure. On « regonfle » la zone (unclip) car DBNet apprend des régions rétrécies.
//   3. Redressement : on rééchantillonne l'image le long de la ligne centrale pour obtenir une
//      bande droite de 48 px de haut, puis on corrige l'éclairage (ombre de la reliure).
//   4. Reconnaissance (SVTR + CTC) par morceaux d'environ 320 px coupés dans les espaces entre
//      les mots : le modèle est entraîné sur des textes courts et décroche sur une ligne entière.
//      Décodage CTC glouton : argmax, on fusionne les répétitions et on retire les blanks.
//   5. Les pas de temps CTC donnent l'abscisse de chaque caractère, donc la boîte de chaque mot.

export const DET_MEAN = [0.485, 0.456, 0.406];
export const DET_STD = [0.229, 0.224, 0.225];
export const REC_HEIGHT = 48;
export const CHUNK_WIDTH = 320;

/** Dimensions d'entrée du détecteur : côté max `maxSide`, multiples de 32. */
export function detInputSize(w, h, maxSide = 1280) {
  const r = Math.min(1, maxSide / Math.max(w, h));
  const round32 = (v) => Math.max(32, Math.round((v * r) / 32) * 32);
  return { w: round32(w), h: round32(h) };
}

/**
 * Pixels RGBA (canvas) → tenseur float32 [1, 3, h, w], ordre des canaux BGR
 * (les modèles Paddle sont entraînés sur des images lues avec OpenCV, donc en BGR).
 * valeur = (pixel / 255 - mean[c]) / std[c]
 */
export function toTensorBGR(rgba, w, h, mean, std) {
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const r = rgba[4 * i] / 255, g = rgba[4 * i + 1] / 255, b = rgba[4 * i + 2] / 255;
    out[i] = (b - mean[0]) / std[0];
    out[n + i] = (g - mean[1]) / std[1];
    out[2 * n + i] = (r - mean[2]) / std[2];
  }
  return out;
}

// ---- 1-2. Détection → géométrie des lignes ---------------------------------------------------

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * Carte de probabilité DBNet (h × w) → lignes de texte, en coordonnées de la carte.
 * Chaque ligne : repère (centre mx,my ; axe co,si), étendue u0..u1 le long de l'axe, ligne
 * centrale `centers` (une valeur v par tranche de largeur binW à partir de binU0), demi-hauteur
 * hh, boîte englobante x0,y0,x1,y1 et score moyen.
 */
export function textLines(prob, w, h, { thresh = 0.3, boxThresh = 0.6, unclip = 1.5, minSize = 3, binW = 6 } = {}) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const lines = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= thresh) continue;
    // Composante connexe (4-voisinage), parcours en profondeur itératif
    const px = [];
    let top = 0, sum = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const p = stack[--top];
      px.push(p);
      sum += prob[p];
      const x = p % w, y = (p - x) / w;
      if (x > 0 && !seen[p - 1] && prob[p - 1] > thresh) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < w - 1 && !seen[p + 1] && prob[p + 1] > thresh) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && !seen[p - w] && prob[p - w] > thresh) { seen[p - w] = 1; stack[top++] = p - w; }
      if (y < h - 1 && !seen[p + w] && prob[p + w] > thresh) { seen[p + w] = 1; stack[top++] = p + w; }
    }
    const n = px.length;
    const score = sum / n;
    if (score < boxThresh || n < minSize * minSize) continue;
    const line = lineGeometry(px, w, unclip, binW);
    if (!line || Math.min(line.length, line.thickness) < minSize) continue;
    line.score = score;
    lines.push(line);
  }
  return lines;
}

/** Géométrie d'une composante : axe principal (ACP), ligne centrale par tranches, unclip. */
function lineGeometry(px, w, unclip, binW) {
  const n = px.length;
  let mx = 0, my = 0;
  for (const p of px) { mx += p % w; my += (p - (p % w)) / w; }
  mx /= n; my /= n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (const p of px) {
    const dx = (p % w) - mx, dy = (p - (p % w)) / w - my;
    cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  // Axe principal : l'angle du grand axe de l'ellipse d'inertie
  const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const co = Math.cos(th), si = Math.sin(th);
  const us = new Float32Array(n), vs = new Float32Array(n);
  let u0 = Infinity, u1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = px[i], dx = (p % w) - mx, dy = (p - (p % w)) / w - my;
    us[i] = dx * co + dy * si;
    vs[i] = -dx * si + dy * co;
    if (us[i] < u0) u0 = us[i];
    if (us[i] > u1) u1 = us[i];
  }
  u0 -= 0.5; u1 += 0.5;
  // Tranches le long de l'axe : bord haut et bas de la zone dans chaque tranche
  const nb = Math.max(1, Math.ceil((u1 - u0) / binW));
  const vmin = new Float32Array(nb).fill(Infinity), vmax = new Float32Array(nb).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const b = Math.min(nb - 1, Math.floor((us[i] - u0) / binW));
    if (vs[i] < vmin[b]) vmin[b] = vs[i];
    if (vs[i] > vmax[b]) vmax[b] = vs[i];
  }
  const filled = [], thick = [];
  for (let b = 0; b < nb; b++) if (vmax[b] >= vmin[b]) { filled.push(b); thick.push(vmax[b] - vmin[b] + 1); }
  if (!filled.length) return null;
  const thickness = median(thick);
  // Centre de chaque tranche ; tranches vides interpolées ; lissage sur ~1,5 hauteur de ligne
  const raw = new Float32Array(nb);
  for (let k = 0; k < filled.length; k++) {
    const b = filled[k];
    raw[b] = (vmin[b] + vmax[b]) / 2;
    const nextB = filled[k + 1];
    if (nextB !== undefined) {
      const nextC = (vmin[nextB] + vmax[nextB]) / 2;
      for (let j = b + 1; j < nextB; j++) raw[j] = raw[b] + ((nextC - raw[b]) * (j - b)) / (nextB - b);
    }
  }
  for (let j = 0; j < filled[0]; j++) raw[j] = raw[filled[0]];
  for (let j = filled[filled.length - 1] + 1; j < nb; j++) raw[j] = raw[filled[filled.length - 1]];
  const r = Math.max(1, Math.round((1.5 * thickness) / binW));
  const centers = new Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, b - r); j <= Math.min(nb - 1, b + r); j++) { s += raw[j]; c++; }
    centers[b] = s / c;
  }
  // Unclip : DBNet prédit une zone rétrécie ; on l'élargit de d = aire × ratio / périmètre
  const length = u1 - u0;
  const d = (length * thickness * unclip) / (2 * (length + thickness));
  const line = {
    mx, my, co, si, binU0: u0, binW, centers,
    u0: u0 - d, u1: u1 + d, hh: thickness / 2 + d,
    length, thickness, angle: (th * 180) / Math.PI,
  };
  // Boîte englobante (pour l'ordre de lecture et l'affichage)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const steps = Math.max(2, nb + 1);
  for (let k = 0; k <= steps; k++) {
    const u = line.u0 + ((line.u1 - line.u0) * k) / steps;
    for (const s of [-1, 1]) {
      const p = linePoint(line, u, s * line.hh);
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
  }
  Object.assign(line, { x0, y0, x1, y1 });
  return line;
}

/** Position v de la ligne centrale et sa pente en u (interpolation linéaire entre tranches). */
function centerAt(line, u) {
  const { centers, binU0, binW } = line;
  const f = (u - binU0) / binW - 0.5;
  const nb = centers.length;
  if (nb === 1) return { v: centers[0], slope: 0 };
  const k = Math.max(0, Math.min(nb - 2, Math.floor(f)));
  const t = Math.max(0, Math.min(1, f - k));
  const slope = (centers[k + 1] - centers[k]) / binW;
  return { v: centers[k] + (centers[k + 1] - centers[k]) * t, slope: f < 0 || f > nb - 1 ? 0 : slope };
}

/** Point de la ligne : abscisse u le long de l'axe, décalage s perpendiculaire à la courbe. */
export function linePoint(line, u, s) {
  const { v, slope } = centerAt(line, u);
  const norm = Math.hypot(slope, 1);
  const U = u - (s * slope) / norm, V = v + s / norm;
  return { x: line.mx + U * line.co - V * line.si, y: line.my + U * line.si + V * line.co };
}

/** Change l'échelle d'une ligne (coordonnées de la carte de détection → image). */
export function scaleLine(line, sx, sy) {
  return { ...line, sx, sy, x0: line.x0 * sx, y0: line.y0 * sy, x1: line.x1 * sx, y1: line.y1 * sy };
}

/** Point de la ligne en coordonnées de l'image. */
export function lineImagePoint(line, u, s) {
  const p = linePoint(line, u, s);
  return { x: p.x * (line.sx ?? 1), y: p.y * (line.sy ?? 1) };
}

// ---- 3. Redressement et éclairage ------------------------------------------------------------

/** Largeur de la bande redressée pour une hauteur outH (même rapport d'aspect que la ligne). */
export function lineCropWidth(line, outH = REC_HEIGHT) {
  return Math.max(16, Math.min(4000, Math.round((outH * (line.u1 - line.u0)) / (2 * line.hh))));
}

/**
 * Rééchantillonne l'image (RGBA, width × height) le long de la ligne : bande droite outW × outH.
 * Interpolation bilinéaire ; hors image, on prolonge le bord.
 */
export function sampleLine(rgba, width, height, line, outH = REC_HEIGHT) {
  const outW = lineCropWidth(line, outH);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = line.sx ?? 1, sy = line.sy ?? 1;
  const L = line.u1 - line.u0;
  for (let x = 0; x < outW; x++) {
    const u = line.u0 + ((x + 0.5) * L) / outW;
    const { v, slope } = centerAt(line, u);
    const norm = Math.hypot(slope, 1);
    for (let y = 0; y < outH; y++) {
      const s = (((y + 0.5) / outH) * 2 - 1) * line.hh;
      const U = u - (s * slope) / norm, V = v + s / norm;
      const fx = (line.mx + U * line.co - V * line.si + 0.5) * sx - 0.5;
      const fy = (line.my + U * line.si + V * line.co + 0.5) * sy - 0.5;
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)));
      const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
      const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
      const i00 = 4 * (y0 * width + x0), i10 = 4 * (y0 * width + x1);
      const i01 = 4 * (y1 * width + x0), i11 = 4 * (y1 * width + x1);
      const o = 4 * (y * outW + x);
      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c] * (1 - ax) + rgba[i10 + c] * ax;
        const bot = rgba[i01 + c] * (1 - ax) + rgba[i11 + c] * ax;
        out[o + c] = top * (1 - ay) + bot * ay;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, w: outW, h: outH };
}

/**
 * Corrige l'éclairage d'une bande de texte (en place, résultat en niveaux de gris) :
 * le fond est estimé colonne par colonne (90e percentile, puis moyenne glissante), on divise
 * par ce fond pour effacer l'ombre de la reliure, puis on étire le contraste (2e-98e percentiles).
 */
export function flatField(rgba, w, h) {
  const n = w * h;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
  const col = new Float32Array(w), tmp = new Float32Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) tmp[y] = L[y * w + x];
    tmp.sort();
    col[x] = tmp[Math.floor(h * 0.9)];
  }
  // Moyenne glissante (somme cumulée) : suit un dégradé régulier sans le biaiser
  const R = Math.round(h / 2);
  const cum = new Float64Array(w + 1);
  for (let x = 0; x < w; x++) cum[x + 1] = cum[x] + col[x];
  const bg = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const a = Math.max(0, x - R), b = Math.min(w, x + R + 1);
    bg[x] = Math.max(1, (cum[b] - cum[a]) / (b - a));
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = Math.min(255, (L[y * w + x] / bg[x]) * 255);
  const sorted = Float32Array.from(L).sort();
  const lo = sorted[Math.floor(n * 0.02)], hi = sorted[Math.floor(n * 0.98)];
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(255, (L[i] - lo) * k));
    rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = v;
    rgba[4 * i + 3] = 255;
  }
  return rgba;
}

// ---- 4. Morceaux et décodage -----------------------------------------------------------------

/**
 * Positions de coupe d'une bande de texte (après flatField) en morceaux de largeur ≤ maxW.
 * On coupe au milieu d'une espace entre deux mots : une suite d'au moins ~10 % de la hauteur
 * de colonnes sans encre (l'interstice entre deux lettres est bien plus étroit). On prend
 * l'espace la plus à droite possible ; à défaut (mot très long), la colonne la plus claire.
 * Renvoie [0, …, w].
 */
export function chunkCuts(rgba, w, h, maxW = CHUNK_WIDTH, minW = 48) {
  if (w <= maxW) return [0, w];
  // Encre par colonne, sur la partie centrale de la bande (les bords peuvent mordre sur les
  // jambages des lignes voisines)
  const ya = Math.floor(h * 0.15), yb = Math.ceil(h * 0.85);
  const ink = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = ya; y < yb; y++) s += 255 - rgba[4 * (y * w + x)];
    ink[x] = s;
  }
  const blankMax = 0.04 * 255 * (yb - ya); // quasi aucune encre dans la colonne
  const minGap = Math.max(4, Math.round(h * 0.1));
  const cuts = [0];
  let pos = 0;
  while (w - pos > maxW) {
    const lo = pos + Math.round(maxW * 0.35), hi = pos + maxW;
    let cut = -1;
    // Espaces (suites de colonnes vides) dont le milieu tombe dans [lo, hi] : la plus à droite
    for (let x = lo - maxW; x < hi + maxW && x < w; ) {
      if (x < 0 || ink[x] > blankMax) { x++; continue; }
      let e = x;
      while (e < w && ink[e] <= blankMax) e++;
      const mid = Math.floor((x + e) / 2);
      if (e - x >= minGap && mid >= lo && mid <= hi) cut = mid;
      x = e;
    }
    if (cut < 0) { // pas d'espace : colonne la moins encrée
      let best = Infinity;
      for (let x = lo; x < hi; x++) if (ink[x] < best) { best = ink[x]; cut = x; }
    }
    cuts.push(cut);
    pos = cut;
  }
  if (w - pos < minW && cuts.length > 1) cuts.pop(); // dernier morceau trop étroit : on le fusionne
  cuts.push(w);
  return cuts;
}

/** Colonnes a..b d'une image RGBA de largeur w. */
export function sliceColumns(rgba, w, h, a, b) {
  const cw = b - a, out = new Uint8ClampedArray(cw * h * 4);
  for (let y = 0; y < h; y++) out.set(rgba.subarray(4 * (y * w + a), 4 * (y * w + b)), 4 * y * cw);
  return out;
}

/**
 * Table des classes du reconnaisseur : 0 = blank, puis les caractères du dictionnaire, puis
 * l'espace si le modèle a une classe de plus (C = nombre de classes en sortie, s'il est connu).
 */
export function buildCharset(keysText, C) {
  const keys = keysText.split(/\r?\n/).filter((k, i, a) => !(k === "" && i === a.length - 1));
  if (C !== undefined && C === keys.length + 1) return ["", ...keys];
  return ["", ...keys, " "];
}

/**
 * Décodage CTC glouton. `probs` : float32 [T × C] (sortie softmax du reconnaisseur).
 * Renvoie le texte et, pour chaque caractère gardé, son pas de temps et sa probabilité.
 */
export function ctcDecode(probs, T, C, charset) {
  const steps = [];
  let prev = 0;
  for (let t = 0; t < T; t++) {
    let best = 0, bestP = -Infinity;
    const o = t * C;
    for (let c = 0; c < C; c++) if (probs[o + c] > bestP) { bestP = probs[o + c]; best = c; }
    if (best !== 0 && best !== prev) steps.push({ char: charset[best] ?? "", t, p: bestP });
    else if (best !== 0 && best === prev && steps.length) {
      // même caractère prolongé : on étend sa fin
      steps[steps.length - 1].tEnd = t;
    }
    prev = best;
  }
  for (const s of steps) s.tEnd = s.tEnd ?? s.t;
  return { text: steps.map((s) => s.char).join(""), steps };
}

// ---- 5. Mots et boîtes -----------------------------------------------------------------------

/**
 * Mots d'une ligne reconnue par morceaux, avec une boîte par mot.
 * `chunks` : [{x0, w, T, steps}] (x0, w en pixels de la bande redressée, largeur totale outW).
 * `boxOf(xa, xb)` : boîte {x, y, w, h} dans l'image du segment xa..xb de la bande.
 * Une coupe entre deux morceaux compte comme un espace.
 */
export function wordsFromChunks(chunks, boxOf) {
  const words = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((s) => s.char).join("");
    const conf = (100 * cur.reduce((a, s) => a + s.p, 0)) / cur.length;
    words.push({ text, conf, box: boxOf(cur[0].xa, cur[cur.length - 1].xb) });
    cur = [];
  };
  for (const ch of chunks) {
    const colW = ch.w / ch.T;
    for (const s of ch.steps) {
      if (s.char === " ") { flush(); continue; }
      // Un caractère s'étale sur environ un pas de temps de part et d'autre de son pic
      cur.push({ ...s, xa: ch.x0 + Math.max(0, s.t - 1) * colW, xb: ch.x0 + Math.min(ch.T, s.tEnd + 2) * colW });
    }
    flush();
  }
  return words.filter((w) => w.text.trim());
}

/** Boîte {x, y, w, h} dans l'image du segment xa..xb d'une bande redressée de largeur outW. */
export function lineSegmentBox(line, outW, xa, xb) {
  const L = line.u1 - line.u0;
  const pts = [];
  for (const x of [xa, (xa + xb) / 2, xb]) {
    const u = line.u0 + (x / outW) * L;
    pts.push(lineImagePoint(line, u, -line.hh), lineImagePoint(line, u, line.hh));
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** Compatibilité : mots d'une ligne horizontale {x0, y0, x1, y1} reconnue d'un seul tenant. */
export function wordsFromSteps(steps, T, line) {
  const W = line.x1 - line.x0;
  return wordsFromChunks([{ x0: 0, w: W, T, steps }], (xa, xb) => ({
    x: line.x0 + xa, y: line.y0, w: xb - xa, h: line.y1 - line.y0,
  }));
}

/** Trie les lignes dans l'ordre de lecture (haut → bas, gauche → droite). */
export function readingOrder(lines) {
  const sorted = [...lines].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const rows = [];
  for (const l of sorted) {
    const row = rows[rows.length - 1];
    const cy = (l.y0 + l.y1) / 2;
    // Même rangée seulement si les centres sont proches (lignes inclinées : boîtes qui se chevauchent)
    if (row && Math.abs(cy - row.cy) < 0.35 * (l.y1 - l.y0) && (l.x0 > row.x1 || l.x1 < row.x0)) {
      row.items.push(l);
      row.x0 = Math.min(row.x0, l.x0); row.x1 = Math.max(row.x1, l.x1);
    } else rows.push({ cy, x0: l.x0, x1: l.x1, items: [l] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x0 - b.x0));
}

const SENTENCE_END = /[.!?…]["”’)]*$/;
const HYPHEN_END = /[-‐‑¬]$/;

/**
 * Assemble la page : lignes ordonnées → mots numérotés, avec n° de ligne et de paragraphe,
 * mots coupés en fin de ligne recollés (champ `full`).
 * `lines` : [{x0,y0,x1,y1, words:[{text, conf, box}]}] déjà dans l'ordre de lecture.
 */
export function buildPage(lines) {
  const heights = lines.map((l) => l.thickness ? 2 * l.hh * (l.sy ?? 1) : l.y1 - l.y0).sort((a, b) => a - b);
  const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  const words = [];
  let para = 0;
  lines.forEach((l, li) => {
    if (li > 0) {
      const prev = lines[li - 1];
      // Interligne mesuré entre les centres (robuste aux lignes inclinées)
      const gap = (l.y0 + l.y1) / 2 - (prev.y0 + prev.y1) / 2 - medH;
      const prevWords = prev.words;
      const lastText = prevWords.length ? prevWords[prevWords.length - 1].text : "";
      // Nouveau paragraphe : grand interligne, ou ligne précédente courte finissant une phrase
      if (gap > 0.8 * medH || (SENTENCE_END.test(lastText) && prev.x1 < l.x1 - 3 * medH)) para++;
    }
    for (const w of l.words) words.push({ ...w, full: w.text, line: li, para, index: words.length, parts: null });
  });
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i], b = words[i + 1];
    if (a.line !== b.line && a.text.length > 1 && HYPHEN_END.test(a.text) && /^\p{L}/u.test(b.text)) {
      a.full = b.full = a.text.replace(HYPHEN_END, "") + b.text;
      a.parts = b.parts = [a.index, b.index];
    }
  }
  return words;
}

/** Texte d'une suite de mots, en sautant la seconde moitié des mots coupés. */
export function textOf(words) {
  const out = [];
  let prev = null;
  for (const w of words) {
    if (w.parts && w.index !== w.parts[0]) continue;
    if (prev) out.push(prev.para !== w.para ? "\n\n" : " ");
    out.push(w.full);
    prev = w;
  }
  return out.join("");
}

/** La phrase qui contient `word` (bornée par . ! ? ou un changement de paragraphe). */
export function sentenceOf(words, word) {
  const i = word.parts ? word.parts[0] : word.index;
  let start = i;
  while (start > 0 && words[start - 1].para === word.para && !SENTENCE_END.test(words[start - 1].text)) start--;
  let end = i;
  while (end < words.length - 1 && !SENTENCE_END.test(words[end].text) && words[end + 1].para === word.para) end++;
  return textOf(words.slice(start, end + 1));
}

// ---- Dictionnaire -------------------------------------------------------------------------

const STRIP = /^[\s"'“”‘’«»()[\]{}.,;:!?…—–\-*_]+|[\s"'“”‘’«»()[\]{}.,;:!?…—–\-*_]+$/g;

/** '“Ran,' → 'Ran' ; "dog's" → 'dog'. Même règle que vocab/dictionary.py. */
export function cleanToken(token) {
  let t = token.replace(STRIP, "");
  if (t.length > 4) t = t.replace(/(?:'s|’s|s'|s’)$/, "");
  return t.replace(STRIP, "");
}

/** Préfixe de fichier du dictionnaire. Même règle que vocab/export_web.py. */
export function shardKey(word) {
  const w = word.toLowerCase();
  let k = "";
  for (const c of w.slice(0, 2)) k += c >= "a" && c <= "z" ? c : "_";
  return k ? (k + "_").slice(0, 2) : "__";
}
