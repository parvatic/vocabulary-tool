// OCR PaddleOCR dans le navigateur avec ONNX Runtime Web (chargé en global `ort` par index.html).
import {
  DET_MEAN, DET_STD, REC_HEIGHT, detInputSize, toTensorBGR, boxesFromProbMap,
  buildCharset, ctcDecode, wordsFromSteps, readingOrder, buildPage,
} from "./ocr-core.js";

const MAX_IMAGE_SIDE = 2400;   // on réduit les photos de 12 Mpx : assez pour lire, plus léger en mémoire
const DET_MAX_SIDE = 1280;     // côté max de l'entrée du détecteur
const REC_MAX_WIDTH = 3200;

let sessions = null;
let charset = null;

export async function loadModels(onProgress = () => {}) {
  if (sessions) return;
  ort.env.wasm.numThreads = 1; // le multi-thread exige une isolation cross-origin (absente sur GitHub Pages)
  onProgress("Chargement du détecteur…");
  const det = await ort.InferenceSession.create("models/det.onnx", { executionProviders: ["wasm"] });
  onProgress("Chargement du reconnaisseur…");
  const rec = await ort.InferenceSession.create("models/rec.onnx", { executionProviders: ["wasm"] });
  charset = buildCharset(await (await fetch("models/keys.txt")).text());
  sessions = { det, rec };
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

function pixels(src, sx, sy, sw, sh, dw, dh) {
  const c = document.createElement("canvas");
  c.width = dw; c.height = dh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh).data;
}

async function detect(canvas) {
  const { w, h } = detInputSize(canvas.width, canvas.height, DET_MAX_SIDE);
  const data = toTensorBGR(pixels(canvas, 0, 0, canvas.width, canvas.height, w, h), w, h, DET_MEAN, DET_STD);
  const s = sessions.det;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, h, w]) });
  const prob = out[s.outputNames[0]].data;
  const sx = canvas.width / w, sy = canvas.height / h;
  return boxesFromProbMap(prob, w, h).map((b) => ({
    x0: b.x0 * sx, y0: b.y0 * sy, x1: b.x1 * sx, y1: b.y1 * sy, score: b.score,
  }));
}

async function recognize(canvas, line) {
  const sw = line.x1 - line.x0, sh = line.y1 - line.y0;
  const w = Math.max(16, Math.min(REC_MAX_WIDTH, Math.ceil((REC_HEIGHT * sw) / sh)));
  const data = toTensorBGR(pixels(canvas, line.x0, line.y0, sw, sh, w, REC_HEIGHT), w, REC_HEIGHT,
    [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  const s = sessions.rec;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, REC_HEIGHT, w]) });
  const t = out[s.outputNames[0]];
  const [, T, C] = t.dims;
  const { text, steps } = ctcDecode(t.data, T, C, charset);
  return { text, words: wordsFromSteps(steps, T, line) };
}

/** Photo → page : mots (avec boîtes, confiance, n° de ligne/paragraphe) dans l'ordre de lecture. */
export async function readPage(canvas, onProgress = () => {}) {
  await loadModels(onProgress);
  onProgress("Détection des lignes…");
  const lines = readingOrder(await detect(canvas));
  for (let i = 0; i < lines.length; i++) {
    onProgress(`Lecture : ligne ${i + 1}/${lines.length}`);
    Object.assign(lines[i], await recognize(canvas, lines[i]));
  }
  return buildPage(lines.filter((l) => l.words.length));
}
