// Tests des fonctions pures : `node --test docs/js/ocr-core.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import {
  detInputSize, toTensorBGR, textLines, scaleLine, sampleLine, flatField, chunkCuts, sliceColumns,
  buildCharset, ctcDecode, wordsFromSteps, wordsFromChunks, lineSegmentBox, readingOrder, buildPage,
  textOf, sentenceOf, cleanToken, shardKey,
} from "./ocr-core.js";

test("taille d'entrée du détecteur : multiples de 32, côté max respecté", () => {
  assert.deepEqual(detInputSize(3000, 4000, 1280), { w: 960, h: 1280 });
  assert.deepEqual(detInputSize(100, 50, 1280), { w: 96, h: 64 });
});

test("tenseur BGR normalisé", () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255]); // un pixel rouge
  const t = toTensorBGR(rgba, 1, 1, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  assert.deepEqual([...t], [-1, -1, 1]); // B, G, R
});

// Carte de probabilité synthétique : bandes de « texte » définies par y = f(x)
function probMap(w, h, bands, v = 0.9) {
  const prob = new Float32Array(w * h);
  for (const { x0, x1, y, half } of bands) {
    for (let x = x0; x < x1; x++) {
      const yc = y(x);
      for (let yy = Math.round(yc - half); yy <= Math.round(yc + half); yy++) if (yy >= 0 && yy < h) prob[yy * w + x] = v;
    }
  }
  return prob;
}

test("DBNet : deux lignes droites → deux lignes, le bruit faible est ignoré", () => {
  const w = 200, h = 80;
  const prob = probMap(w, h, [{ x0: 10, x1: 180, y: () => 15, half: 3 }, { x0: 10, x1: 120, y: () => 45, half: 3 }]);
  for (let y = 70; y < 74; y++) for (let x = 190; x < 194; x++) prob[y * w + x] = 0.4; // bruit : score < 0.6
  const lines = textLines(prob, w, h).sort((a, b) => a.y0 - b.y0);
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(lines[0].angle) < 0.5);
  assert.ok(lines[0].x0 < 10 && lines[0].x1 > 180 && lines[0].y0 < 12 && lines[0].y1 > 18, "zone regonflée (unclip)");
});

test("ligne inclinée : l'angle est retrouvé", () => {
  const w = 300, h = 120, a = (5 * Math.PI) / 180;
  const prob = probMap(w, h, [{ x0: 20, x1: 280, y: (x) => 30 + (x - 20) * Math.tan(a), half: 3 }]);
  const [line] = textLines(prob, w, h);
  assert.ok(Math.abs(line.angle - 5) < 0.5, `angle ${line.angle}`);
});

test("ligne courbe (reliure) : la bande redressée est droite", () => {
  const w = 400, h = 160;
  const curve = (x) => 60 + 40 * Math.pow(1 - x / w, 3); // monte fortement vers la gauche
  const prob = probMap(w, h, [{ x0: 10, x1: 390, y: curve, half: 4 }]);
  // Image : fond blanc, trait noir le long de la même courbe
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let x = 10; x < 390; x++) for (let d = -2; d <= 2; d++) {
    const i = 4 * (Math.round(curve(x) + d) * w + x);
    rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
  }
  const [line] = textLines(prob, w, h);
  const crop = sampleLine(rgba, w, h, scaleLine(line, 1, 1), 48);
  // Pour chaque colonne, la rangée la plus sombre doit rester au milieu de la bande
  let ok = 0, n = 0;
  for (let x = Math.round(crop.w * 0.05); x < crop.w * 0.95; x++) {
    let best = 0, bv = 999;
    for (let y = 0; y < 48; y++) { const v = crop.data[4 * (y * crop.w + x)]; if (v < bv) { bv = v; best = y; } }
    n++; if (Math.abs(best - 24) <= 6) ok++;
  }
  assert.ok(ok / n > 0.95, `trait centré dans ${(100 * ok / n).toFixed(0)} % des colonnes`);
});

test("coupes en morceaux : dans les espaces, largeur ≤ max, pas de morceau minuscule", () => {
  const w = 1000, h = 48, rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  // « mots » noirs de 70 px séparés par des espaces de 15 px
  for (let x = 0; x < w; x++) if (x % 85 < 70) for (let y = 10; y < 38; y++) { const i = 4 * (y * w + x); rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; }
  const cuts = chunkCuts(rgba, w, h, 320);
  assert.equal(cuts[0], 0); assert.equal(cuts[cuts.length - 1], w);
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i] - cuts[i - 1] <= 320 && cuts[i] - cuts[i - 1] >= 48);
  for (const c of cuts.slice(1, -1)) assert.ok(c % 85 >= 70, `coupe à ${c} dans un espace`);
  const part = sliceColumns(rgba, w, h, cuts[0], cuts[1]);
  assert.equal(part.length, (cuts[1] - cuts[0]) * h * 4);
});

test("coupes en morceaux : jamais entre deux lettres d'un même mot", () => {
  // lettres de 7 px séparées de 2 px ; mots de 3 à 11 lettres séparés de 10 px
  const w = 1400, h = 48, rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const wordSpans = [];
  let x = 4, n = 0;
  while (x < w - 120) {
    const letters = 3 + ((n * 7) % 9), start = x;
    for (let l = 0; l < letters; l++) {
      for (let xx = x; xx < x + 7; xx++) for (let y = 12; y < 36; y++) { const i = 4 * (y * w + xx); rgba[i] = rgba[i + 1] = rgba[i + 2] = 20; }
      x += 9;
    }
    wordSpans.push([start, x - 2]);
    x += 10; n++;
  }
  const cuts = chunkCuts(rgba, w, h, 320);
  for (const c of cuts.slice(1, -1)) {
    assert.ok(!wordSpans.some(([a, b]) => c >= a && c < b), `coupe à ${c} à l'intérieur d'un mot`);
  }
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i] - cuts[i - 1] <= 320);
});

test("coupes en morceaux : mot plus long qu'un morceau → coupe de secours, sans boucle infinie", () => {
  const w = 900, h = 48, rgba = new Uint8ClampedArray(w * h * 4).fill(20); // tout encré
  const cuts = chunkCuts(rgba, w, h, 320);
  assert.equal(cuts[cuts.length - 1], w);
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i] > cuts[i - 1] && cuts[i] - cuts[i - 1] <= 320);
});

test("éclairage : l'ombre de la reliure est effacée", () => {
  const w = 300, h = 48, rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const bg = 90 + (150 * x) / w; // fond sombre à gauche, clair à droite
    const ink = y > 18 && y < 30 && x % 20 < 8;
    const i = 4 * (y * w + x); rgba[i] = rgba[i + 1] = rgba[i + 2] = ink ? bg * 0.3 : bg; rgba[i + 3] = 255;
  }
  flatField(rgba, w, h);
  const at = (x, y) => rgba[4 * (y * w + x)];
  assert.ok(at(10, 5) > 220 && at(290, 5) > 220, "fond blanc des deux côtés");
  assert.ok(at(2, 24) < 60 && at(282, 24) < 60, "texte noir des deux côtés");
});

test("CTC : répétitions fusionnées, blank sépare les doubles lettres", () => {
  const charset = buildCharset("h\ne\nl\no\n");
  assert.deepEqual(charset, ["", "h", "e", "l", "o", " "]);
  assert.deepEqual(buildCharset("h\ne\n ", 4), ["", "h", "e", " "], "espace déjà dans le dictionnaire");
  // h h e _ l l _ l o   (_ = blank) → "hello"
  const seq = [1, 1, 2, 0, 3, 3, 0, 3, 4];
  const C = charset.length, T = seq.length;
  const probs = new Float32Array(T * C);
  seq.forEach((c, t) => (probs[t * C + c] = 0.9));
  const { text, steps } = ctcDecode(probs, T, C, charset);
  assert.equal(text, "hello");
  assert.deepEqual(steps.map((s) => [s.t, s.tEnd]), [[0, 1], [2, 2], [4, 5], [7, 7], [8, 8]]);
});

test("CTC → mots avec boîtes", () => {
  const charset = buildCharset("a\nb\n");
  // a _ b ␣ ␣ a a  → "ab a"
  const seq = [1, 0, 2, 3, 3, 1, 1];
  const C = charset.length, T = seq.length, probs = new Float32Array(T * C);
  seq.forEach((c, t) => (probs[t * C + c] = 1));
  const { text, steps } = ctcDecode(probs, T, C, charset);
  assert.equal(text, "ab a");
  const words = wordsFromSteps(steps, T, { x0: 0, y0: 10, x1: 70, y1: 30 });
  assert.deepEqual(words.map((w) => w.text), ["ab", "a"]);
  assert.ok(words[0].box.x + words[0].box.w <= words[1].box.x + 1e-9, "les boîtes se suivent");
  assert.equal(words[1].box.y, 10);
});

test("morceaux → mots : une coupe sépare deux mots, positions dans la bande", () => {
  const st = (char, t) => ({ char, t, tEnd: t, p: 0.9 });
  const chunks = [
    { x0: 0, w: 80, T: 10, steps: [st("o", 1), st("n", 2), st(" ", 4), st("t", 6), st("h", 7), st("e", 8)] },
    { x0: 80, w: 80, T: 10, steps: [st("d", 1), st("o", 2), st("g", 3)] },
  ];
  const words = wordsFromChunks(chunks, (xa, xb) => ({ x: xa, y: 0, w: xb - xa, h: 10 }));
  assert.deepEqual(words.map((w) => w.text), ["on", "the", "dog"]);
  assert.ok(words[2].box.x >= 80, "le 3e mot est dans le 2e morceau");
});

test("boîte d'un segment de ligne : dans l'image, à la bonne échelle", () => {
  const w = 200, h = 80;
  const prob = probMap(w, h, [{ x0: 20, x1: 180, y: () => 40, half: 4 }]);
  const line = scaleLine(textLines(prob, w, h)[0], 2, 2);
  const outW = 400;
  const b = lineSegmentBox(line, outW, 0, outW);
  assert.ok(b.x < 40 && b.x + b.w > 360, `x ${b.x}..${b.x + b.w}`);
  assert.ok(b.y < 72 && b.y + b.h > 88, `y ${b.y}..${b.y + b.h}`);
});

const L = (y, x0, x1, ...texts) => ({ x0, x1, y0: y, y1: y + 20, words: texts.map((t) => ({ text: t, conf: 95 })) });

test("ordre de lecture : haut → bas puis gauche → droite", () => {
  const order = readingOrder([L(50, 0, 100), L(0, 200, 300), L(2, 0, 100)]);
  assert.deepEqual(order.map((l) => [l.y0, l.x0]), [[2, 0], [0, 200], [50, 0]]);
});

test("ordre de lecture : lignes inclinées qui se chevauchent restent séparées", () => {
  // boîtes de 40 px de haut, décalées de 24 px : elles se chevauchent mais sont deux lignes
  const a = { x0: 0, x1: 500, y0: 0, y1: 40 }, b = { x0: 0, x1: 500, y0: 24, y1: 64 };
  assert.deepEqual(readingOrder([b, a]), [a, b]);
});

test("page : césure recollée, phrases et paragraphes", () => {
  const lines = [
    L(0, 0, 400, "She", "ran", "the", "family", "business."),
    L(24, 0, 400, "Her", "neigh-"),
    L(48, 0, 200, "bours", "thought", "she", "was", "mad."),
    L(110, 0, 400, "The", "water", "had", "receded."),
  ];
  const words = buildPage(lines);
  assert.equal(words.find((w) => w.text === "neigh-").full, "neighbours");
  assert.equal(textOf(words), "She ran the family business. Her neighbours thought she was mad.\n\nThe water had receded.");
  const ran = words.find((w) => w.text === "ran");
  assert.equal(sentenceOf(words, ran), "She ran the family business.");
  const bours = words.find((w) => w.text === "bours");
  assert.equal(sentenceOf(words, bours), "Her neighbours thought she was mad.");
  assert.equal(sentenceOf(words, words.find((w) => w.text === "water")), "The water had receded.");
});

test("nettoyage des mots et préfixes du dictionnaire (mêmes règles qu'en Python)", () => {
  assert.equal(cleanToken("“Ran,"), "Ran");
  assert.equal(cleanToken("dog's"), "dog");
  assert.equal(cleanToken("it's"), "it's");
  assert.equal(shardKey("Run"), "ru");
  assert.equal(shardKey("a"), "a_");
  assert.equal(shardKey("'tis"), "_t");
  assert.equal(shardKey("éclair"), "_c");
});
