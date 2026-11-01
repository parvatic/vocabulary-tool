// Fonctions pures de l'OCR PaddleOCR (sans ONNX Runtime ni DOM) : testables avec Node.
//
// Pipeline (le même que dans le cours) :
//   1. Détection (DBNet) : le modèle renvoie une carte de probabilité « ici il y a du texte ».
//      On la seuille, on regroupe les pixels voisins (composantes connexes) et chaque groupe
//      devient une boîte, qu'on regonfle (« unclip ») car DBNet apprend des régions rétrécies.
//   2. Reconnaissance (SVTR/CRNN + CTC) : chaque ligne découpée est redimensionnée à 48 px de
//      haut ; le modèle renvoie, pour chaque tranche verticale (pas de temps), une distribution
//      sur les caractères + un symbole « blank ». Décodage CTC glouton : argmax, on fusionne les
//      répétitions et on retire les blanks.
//   3. Les positions des pas de temps CTC donnent l'abscisse de chaque caractère, donc les
//      boîtes de chaque mot, alors que le détecteur ne renvoie que des lignes.

export const DET_MEAN = [0.485, 0.456, 0.406];
export const DET_STD = [0.229, 0.224, 0.225];
export const REC_HEIGHT = 48;

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

/**
 * Post-traitement DBNet : carte de probabilité (h × w) → boîtes alignées sur les axes.
 * Simplification assumée par rapport à PaddleOCR (polygones orientés) : sur une page de
 * livre photographiée à peu près droite, les lignes sont horizontales.
 */
export function boxesFromProbMap(prob, w, h, { thresh = 0.3, boxThresh = 0.6, unclip = 1.5, minSize = 3 } = {}) {
  const label = new Int32Array(w * h);
  const boxes = [];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (label[start] || prob[start] <= thresh) continue;
    // Composante connexe (4-voisinage) par parcours en profondeur itératif
    let top = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, sum = 0, count = 0;
    stack[top++] = start;
    label[start] = next;
    while (top) {
      const p = stack[--top];
      const x = p % w, y = (p - x) / w;
      sum += prob[p]; count++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      const neighbours = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of neighbours) {
        if (q >= 0 && !label[q] && prob[q] > thresh) { label[q] = next; stack[top++] = q; }
      }
    }
    next++;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < minSize) continue;
    const score = sum / count;
    if (score < boxThresh) continue;
    // Unclip : DBNet prédit un « noyau » rétréci ; on l'agrandit de d = aire × ratio / périmètre
    const d = (bw * bh * unclip) / (2 * (bw + bh));
    boxes.push({
      x0: Math.max(0, x0 - d), y0: Math.max(0, y0 - d),
      x1: Math.min(w, x1 + 1 + d), y1: Math.min(h, y1 + 1 + d),
      score,
    });
  }
  return boxes;
}

/** Table des classes du reconnaisseur : 0 = blank, puis les caractères, puis l'espace. */
export function buildCharset(keysText) {
  const keys = keysText.split(/\r?\n/).filter((k, i, a) => !(k === "" && i === a.length - 1));
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

/**
 * Découpe une ligne reconnue en mots, avec une boîte par mot (coordonnées de l'image).
 * `line` = {x0, y0, x1, y1} de la ligne découpée ; `T` = nombre de pas de temps.
 */
export function wordsFromSteps(steps, T, line) {
  const colW = (line.x1 - line.x0) / T;
  const words = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((s) => s.char).join("");
    const conf = (100 * cur.reduce((a, s) => a + s.p, 0)) / cur.length;
    // Un caractère s'étale sur environ un pas de temps de part et d'autre de son pic
    const x0 = line.x0 + Math.max(0, cur[0].t - 1) * colW;
    const x1 = line.x0 + Math.min(T, cur[cur.length - 1].tEnd + 2) * colW;
    words.push({ text, conf, box: { x: x0, y: line.y0, w: x1 - x0, h: line.y1 - line.y0 } });
    cur = [];
  };
  for (const s of steps) {
    if (s.char === " ") flush();
    else cur.push(s);
  }
  flush();
  return words;
}

/** Trie les lignes dans l'ordre de lecture (haut → bas, gauche → droite). */
export function readingOrder(lines) {
  const sorted = [...lines].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const rows = [];
  for (const l of sorted) {
    const row = rows[rows.length - 1];
    const cy = (l.y0 + l.y1) / 2;
    if (row && cy < row.y1 && cy > row.y0) { row.items.push(l); row.y1 = Math.max(row.y1, l.y1); }
    else rows.push({ y0: l.y0, y1: l.y1, items: [l] });
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
  const heights = lines.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
  const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  const words = [];
  let para = 0;
  lines.forEach((l, li) => {
    if (li > 0) {
      const prev = lines[li - 1];
      const gap = l.y0 - prev.y1;
      // Nouveau paragraphe : grand interligne, ou ligne précédente courte finissant une phrase
      const prevWords = prev.words;
      const lastText = prevWords.length ? prevWords[prevWords.length - 1].text : "";
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
