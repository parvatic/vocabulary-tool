import { imageToCanvas, readPage, loadModels } from "./ocr.js";
import { sentenceOf, cleanToken } from "./ocr-core.js";
import { lookup, expressionsAround } from "./dict.js";
import * as store from "./store.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) n.append(c);
  return n;
};

let page = null;      // { canvas, words }
let current = null;   // { word, sentence } en cours de consultation

// ---- Onglets ----------------------------------------------------------------------------
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === b));
  $("view-read").hidden = b.dataset.view !== "read";
  $("view-list").hidden = b.dataset.view !== "list";
  if (b.dataset.view === "list") renderList();
}));

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 1800);
}

function updateCount() {
  const n = store.all().length;
  $("count").textContent = n ? `(${n})` : "";
}

// ---- Photo → OCR --------------------------------------------------------------------------
$("photo").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  const status = (s) => ($("status").textContent = s);
  try {
    status("Préparation de l'image…");
    const canvas = await imageToCanvas(file);
    $("page-img").src = canvas.toDataURL("image/jpeg", 0.85);
    $("page").hidden = false;
    $("overlay").replaceChildren();
    const t0 = performance.now();
    const words = await readPage(canvas, status);
    page = { canvas, words };
    drawOverlay();
    status(`${words.length} mots lus en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    $("hint").hidden = !words.length;
    $("capture-label").textContent = "Photographier une autre page";
  } catch (e) {
    console.error(e);
    status("Erreur : " + e.message);
  }
});

function drawOverlay() {
  const { canvas, words } = page;
  const pct = (v, total) => `${(100 * v) / total}%`;
  $("overlay").replaceChildren(...words.map((w) => {
    const b = el("button", { className: "w" + (w.conf < 70 ? " low" : ""), title: w.full });
    Object.assign(b.style, {
      left: pct(w.box.x, canvas.width), top: pct(w.box.y, canvas.height),
      width: pct(w.box.w, canvas.width), height: pct(w.box.h, canvas.height),
    });
    b.setAttribute("aria-label", w.full);
    b.addEventListener("click", () => select(w, b));
    return b;
  }));
}

function select(w, btn) {
  document.querySelectorAll(".w.selected").forEach((x) => x.classList.remove("selected"));
  btn.classList.add("selected");
  const text = cleanToken(w.full);
  current = { word: text, sentence: sentenceOf(page.words, w), context: contextOf(page.words, w) };
  openSheet(text);
}

/** Mots voisins du mot touché (même paragraphe), pour repérer les expressions (look into…). */
function contextOf(words, w) {
  const idx = w.parts ? w.parts[0] : w.index;
  const list = [];
  for (let j = Math.max(0, idx - 8); j < Math.min(words.length, idx + 9); j++) {
    const x = words[j];
    if (x.para !== w.para || (x.parts && x.index !== x.parts[0])) continue;
    list.push({ raw: x.full, index: x.index });
  }
  return { tokens: list.map((t) => t.raw), i: list.findIndex((t) => t.index === idx) };
}

// ---- Fiche de traduction ----------------------------------------------------------------
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Phrase avec les mots `marks` surlignés, dans l'ordre (par défaut : le mot cherché). */
function renderSentence(marks) {
  const s = $("sheet-sentence");
  s.replaceChildren();
  if (!current?.sentence) return;
  const text = current.sentence;
  let pos = 0;
  for (const m of (marks?.length ? marks : [current.word]).map((x) => cleanToken(x)).filter(Boolean)) {
    const r = new RegExp(`(^|[^\\p{L}])(${escapeRe(m)})(?![\\p{L}])`, "iu").exec(text.slice(pos));
    if (!r) continue;
    const at = pos + r.index + r[1].length;
    s.append(text.slice(pos, at), el("mark", { textContent: r[2] }));
    pos = at + r[2].length;
  }
  s.append(text.slice(pos));
}

async function openSheet(word) {
  $("sheet").hidden = false;
  $("sheet-word").value = word;
  $("manual-fr").value = "";
  renderSentence();
  await search(word);
}

async function search(word) {
  const box = $("sheet-results");
  box.replaceChildren(el("p", { className: "hint", textContent: "Recherche…" }));
  let entries, exprs = [];
  try {
    entries = await lookup(word);
    exprs = await expressionsInContext(word);
  } catch (e) { box.replaceChildren(el("p", { className: "hint", textContent: "Dictionnaire indisponible : " + e.message })); return; }
  const nothing = !entries.length && !exprs.length;
  document.querySelector("details.manual").open = nothing;
  renderSentence(exprs[0]?.marks);
  if (nothing) {
    const input = $("sheet-word");
    input.focus(); input.select();
    box.replaceChildren(el("p", { className: "hint", textContent: "Pas trouvé. Si l'OCR s'est trompé, corrige le mot dans le champ en haut puis touche « Chercher ». Sinon, ajoute ta propre traduction ci-dessous." }));
    return;
  }
  const blocks = [];
  if (exprs.length) {
    blocks.push(el("p", { className: "section", textContent: "Dans cette phrase" }));
    for (const x of exprs) for (const e of x.entries) blocks.push(renderEntry(e, x));
    if (entries.length) blocks.push(el("p", { className: "section", textContent: `Le mot seul : ${word}` }));
  }
  blocks.push(...entries.map((e) => renderEntry(e)));
  box.replaceChildren(...blocks);
}

/** Expressions de la phrase qui contiennent le mot (éventuellement corrigé à la main). */
async function expressionsInContext(word) {
  const ctx = current?.context;
  if (!ctx || ctx.i < 0 || /\s/.test(word)) return [];
  const tokens = [...ctx.tokens];
  const raw = tokens[ctx.i];
  if (cleanToken(raw).toLowerCase() !== word.toLowerCase()) {
    tokens[ctx.i] = word + (raw.match(/[.,;:!?…—–)\]"”]+$/)?.[0] ?? ""); // garde la ponctuation
  }
  return expressionsAround(tokens, ctx.i);
}

/** Une entrée du dictionnaire ; `expr` si elle vient d'une expression trouvée dans la phrase. */
function renderEntry(e, expr = null) {
  const head = el("div", { className: "entry-head" },
    el("span", { className: "lemma", textContent: e.word }),
    el("span", { className: "pos", textContent: e.pos }));
  if (expr) head.append(el("span", { className: "pill", textContent: "expression" }));
  if (e.via) head.append(el("span", { className: "via", textContent: e.via }));
  const senses = Object.entries(e.fr).map(([sense, fr]) => {
    const b = el("button", { className: "sense" },
      el("span", {}, el("span", { className: "fr", textContent: fr.join(", ") }),
        el("span", { className: "label", textContent: sense || "sens non précisé" })),
      el("span", { className: "plus", textContent: "+" }));
    b.addEventListener("click", () => addWord(e, fr.join("; "), sense, expr));
    return b;
  });
  const node = el("div", { className: "entry" + (expr ? " entry-expr" : "") }, head, ...senses);
  if (e.syn.length) node.append(el("p", { className: "syn", textContent: "≈ " + e.syn.join(", ") }));
  if (e.gloss.length) node.append(el("ol", { className: "gloss" }, ...e.gloss.map((g) => el("li", { textContent: g }))));
  if (!senses.length) {
    // Pas de traduction française dans le dictionnaire : on garde la définition, tu traduis
    const input = el("input", { placeholder: "Ta traduction en français" });
    const btn = el("button", { textContent: "Ajouter" });
    btn.addEventListener("click", () => {
      const fr = input.value.trim();
      if (fr) addWord(e, fr, e.gloss[0] || "", expr); else input.focus();
    });
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") btn.click(); });
    node.append(el("p", { className: "hint left", textContent: "Pas de traduction française dans le dictionnaire." }),
      el("div", { className: "manual-row" }, input, btn));
  }
  return node;
}

function addWord(entry, french, definition, expr = null) {
  const n = store.add({
    word: expr ? expr.text : current?.word ?? entry.word, lemma: entry.word, pos: entry.pos, french,
    synonyms: entry.syn.slice(0, 6).join("; "), definition, sentence: current?.sentence ?? "",
  });
  updateCount();
  toast(n > 1 ? `Déjà dans ta liste (vu ${n} fois)` : `« ${entry.word} » ajouté`);
  closeSheet();
}

function closeSheet() { $("sheet").hidden = true; }

$("sheet-close").addEventListener("click", closeSheet);
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
$("word-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  current = { ...current, word: $("sheet-word").value.trim() };
  search(current.word);
});
$("manual-add").addEventListener("click", () => {
  const fr = $("manual-fr").value.trim();
  const word = $("sheet-word").value.trim();
  if (!fr || !word) return;
  addWord({ word: word.toLowerCase(), pos: "", syn: [] }, fr, "");
});

// ---- Liste ---------------------------------------------------------------------------------
function renderList() {
  const items = store.all();
  $("empty").hidden = items.length > 0;
  $("list").replaceChildren(...items.map((r) => {
    const del = el("button", { className: "icon del", textContent: "✕", ariaLabel: "Supprimer" });
    del.addEventListener("click", () => { store.remove(r.id); renderList(); updateCount(); });
    return el("li", { className: "card" },
      el("div", {}, el("span", { className: "lemma", textContent: r.lemma }), " ",
        el("span", { className: "pos", textContent: r.pos })),
      el("div", { className: "fr", textContent: r.french }),
      r.synonyms ? el("div", { className: "meta", textContent: "≈ " + r.synonyms }) : "",
      r.sentence ? el("p", { className: "sentence", textContent: r.sentence }) : "",
      el("div", { className: "meta", textContent: r.timesSeen > 1 ? `vu ${r.timesSeen} fois` : "" }),
      del);
  }));
}

async function shareOrDownload(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; } catch { /* annulé */ }
  }
  const a = el("a", { href: URL.createObjectURL(file), download: file.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const today = () => new Date().toISOString().slice(0, 10);

$("export").addEventListener("click", () =>
  shareOrDownload(new File([store.toAnkiCsv()], "vocabulaire-anki.csv", { type: "text/csv" })));

$("backup").addEventListener("click", () =>
  shareOrDownload(new File([store.toBackupJson()], `vocabulaire-sauvegarde-${today()}.json`, { type: "application/json" })));

$("restore").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const added = store.restoreFromJson(await file.text());
    renderList(); updateCount();
    toast(added ? `${added} mot(s) restauré(s)` : "Rien de nouveau dans cette sauvegarde");
  } catch (e) { alert("Restauration impossible : " + e.message); }
});

function renderStorageStatus() {
  $("storage-status").textContent = store.isPersisted()
    ? "Enregistré sur ce téléphone, en stockage persistant. Pense à sauvegarder de temps en temps."
    : "Enregistré sur ce téléphone. Pour ne rien perdre, utilise l'app depuis l'écran d'accueil et sauvegarde de temps en temps.";
}

// ---- Démarrage -----------------------------------------------------------------------------
store.init().then(() => { updateCount(); renderStorageStatus(); renderList(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
// Précharge les modèles en arrière-plan pour que la première photo soit plus rapide
loadModels().catch((e) => ($("status").textContent = "Modèles OCR introuvables : " + e.message));
