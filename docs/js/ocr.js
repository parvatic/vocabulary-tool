// OCR PaddleOCR dans le navigateur avec ONNX Runtime Web (chargé en global `ort` par index.html).
// Détecteur : PP-OCR mobile (DBNet). Reconnaisseur : PP-OCRv5 anglais (SVTR + CTC).
// Le détail des étapes est dans ocr-core.js.
import {
  DET_MEAN, DET_STD, REC_HEIGHT, CHUNK_WIDTH, detInputSize, toTensorBGR, textLines, scaleLine,
  sampleLine, flatField, chunkCuts, sliceColumns, buildCharset, ctcDecode, wordsFromChunks,
  lineSegmentBox, readingOrder, buildPage,
} from "./ocr-core.js";

const MAX_IMAGE_SIDE = 2400;   // on réduit les photos de 12 Mpx : assez pour lire, plus léger en mémoire
const DET_MAX_SIDE = 1280;     // côté max de l'entrée du détecteur

let sessions = null;
let keysText = null;
let charset = null;
let loading = null; // promesse partagée : un seul chargement, même si une photo arrive pendant le préchargement

async function step(label, fn) {
  try { return await fn(); }
  catch (e) { throw new Error(`${label} : ${e?.message || e}`); }
}

export function loadModels(onProgress = () => {}) {
  if (sessions) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      ort.env.wasm.numThreads = 1; // le multi-thread exige une isolation cross-origin (absente sur GitHub Pages)
      const opts = { executionProviders: ["wasm"] };
      onProgress("Chargement du détecteur…");
      const det = await step("models/det.onnx", () => ort.InferenceSession.create("models/det.onnx", opts));
      onProgress("Chargement du reconnaisseur…");
      const rec = await step("models/rec.onnx", () => ort.InferenceSession.create("models/rec.onnx", opts));
      keysText = await step("models/keys.txt", async () => {
        const r = await fetch("models/keys.txt");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
      sessions = { det, rec };
    })().catch((e) => { loading = null; throw e; }); // en cas d'échec, on pourra réessayer
  } else {
    onProgress("Chargement des modèles…");
  }
  return loading;
}

/** Fichier image (photo) → canvas, orientation EXIF appliquée, réduit à MAX_IMAGE_SIDE. */
export async function imageToCanvas(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const r = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * r);
  c.height = Math.round(bmp.height * r);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

/** Lignes de texte de la photo, en coordonnées du canvas. */
async function detect(canvas) {
  const { w, h } = detInputSize(canvas.width, canvas.height, DET_MAX_SIDE);
  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, w, h);
  const data = toTensorBGR(ctx.getImageData(0, 0, w, h).data, w, h, DET_MEAN, DET_STD);
  const s = sessions.det;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, h, w]) });
  const sx = canvas.width / w, sy = canvas.height / h;
  return textLines(out[s.outputNames[0]].data, w, h).map((l) => scaleLine(l, sx, sy));
}

/** Reconnaissance d'un morceau de bande (RGBA, largeur w, hauteur REC_HEIGHT). */
async function recognizeChunk(rgba, w) {
  const data = toTensorBGR(rgba, w, REC_HEIGHT, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  const s = sessions.rec;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, REC_HEIGHT, w]) });
  const t = out[s.outputNames[0]];
  const [, T, C] = t.dims;
  charset ??= buildCharset(keysText, C);
  return { T, ...ctcDecode(t.data, T, C, charset) };
}

/** Une ligne : redressement le long de sa courbe, éclairage, lecture par morceaux, mots. */
async function recognize(img, line) {
  const strip = sampleLine(img.data, img.width, img.height, line, REC_HEIGHT);
  flatField(strip.data, strip.w, strip.h);
  const cuts = chunkCuts(strip.data, strip.w, strip.h, CHUNK_WIDTH);
  const chunks = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    const r = await recognizeChunk(sliceColumns(strip.data, strip.w, strip.h, a, b), b - a);
    chunks.push({ x0: a, w: b - a, T: r.T, steps: r.steps });
  }
  return { words: wordsFromChunks(chunks, (xa, xb) => lineSegmentBox(line, strip.w, xa, xb)) };
}

/** Photo → page : mots (avec boîtes, confiance, n° de ligne/paragraphe) dans l'ordre de lecture. */
export async function readPage(canvas, onProgress = () => {}) {
  await loadModels(onProgress);
  onProgress("Détection des lignes…");
  const lines = readingOrder(await detect(canvas));
  const img = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < lines.length; i++) {
    onProgress(`Lecture : ligne ${i + 1}/${lines.length}`);
    Object.assign(lines[i], await recognize(img, lines[i]));
  }
  return buildPage(lines.filter((l) => l.words.length));
}
