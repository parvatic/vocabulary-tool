// Tests des fonctions pures : `node --test docs/js/`
import test from "node:test";
import assert from "node:assert/strict";
import {
  detInputSize, toTensorBGR, boxesFromProbMap, buildCharset, ctcDecode, wordsFromSteps,
  readingOrder, buildPage, textOf, sentenceOf, cleanToken, shardKey,
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

test("DBNet : deux régions de texte → deux boîtes, le bruit faible est ignoré", () => {
  const w = 40, h = 20, prob = new Float32Array(w * h);
  const fill = (x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) prob[y * w + x] = v; };
  fill(2, 2, 30, 6, 0.9);    // ligne 1
  fill(2, 10, 20, 14, 0.8);  // ligne 2
  fill(35, 16, 38, 19, 0.4); // bruit : score < 0.6
  const boxes = boxesFromProbMap(prob, w, h);
  assert.equal(boxes.length, 2);
  const [a] = boxes;
  assert.ok(a.x0 < 2 && a.x1 > 30 && a.y0 < 2 && a.y1 > 6, "la boîte est regonflée (unclip)");
});

test("CTC : répétitions fusionnées, blank sépare les doubles lettres", () => {
  const charset = buildCharset("h\ne\nl\no\n");
  assert.deepEqual(charset, ["", "h", "e", "l", "o", " "]);
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

const L = (y, x0, x1, ...texts) => ({ x0, x1, y0: y, y1: y + 20, words: texts.map((t) => ({ text: t, conf: 95 })) });

test("ordre de lecture : haut → bas puis gauche → droite", () => {
  const order = readingOrder([L(50, 0, 100), L(0, 200, 300), L(2, 0, 100)]);
  assert.deepEqual(order.map((l) => [l.y0, l.x0]), [[2, 0], [0, 200], [50, 0]]);
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
