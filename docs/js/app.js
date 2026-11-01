import { imageToCanvas, readPage, loadModels } from "./ocr.js";
import { sentenceOf, cleanToken } from "./ocr-core.js";
import { lookup } from "./dict.js";
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
  current = { word: text, sentence: sentenceOf(page.words, w) };
  openSheet(text);
}

// ---- Fiche de traduction ----------------------------------------------------------------
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function renderSentence() {
  const s = $("sheet-sentence");
  s.replaceChildren();
  if (!current?.sentence) return;
  const parts = current.sentence.split(new RegExp(`(${escapeRe(current.word)})`, "i"));
  parts.forEach((p, i) => s.append(i % 2 ? el("mark", { textContent: p }) : p));
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
  let entries;
  try { entries = await lookup(word); }
  catch (e) { box.replaceChildren(el("p", { className: "hint", textContent: "Dictionnaire indisponible : " + e.message })); return; }
  document.querySelector("details.manual").open = !entries.length;
  if (!entries.length) {
    box.replaceChildren(el("p", { className: "hint", textContent: "Pas trouvé. Corrige le mot ci-dessus si l'OCR s'est trompé, ou ajoute ta traduction." }));
    return;
  }
  box.replaceChildren(...entries.map((e) => {
    const head = el("div", { className: "entry-head" },
      el("span", { className: "lemma", textContent: e.word }),
      el("span", { className: "pos", textContent: e.pos }));
    if (e.via) head.append(el("span", { className: "via", textContent: e.via }));
    const senses = Object.entries(e.fr).map(([sense, fr]) => {
      const b = el("button", { className: "sense" },
        el("span", {}, el("span", { className: "fr", textContent: fr.join(", ") }),
          el("span", { className: "label", textContent: sense || "sens non précisé" })),
        el("span", { className: "plus", textContent: "+" }));
      b.addEventListener("click", () => addWord(e, fr.join("; "), sense));
      return b;
    });
    const node = el("div", { className: "entry" }, head, ...senses);
    if (e.syn.length) node.append(el("p", { className: "syn", textContent: "≈ " + e.syn.join(", ") }));
    if (e.gloss.length) node.append(el("ol", { className: "gloss" }, ...e.gloss.map((g) => el("li", { textContent: g }))));
    return node;
  }));
}

function addWord(entry, french, definition) {
  const n = store.add({
    word: current?.word ?? entry.word, lemma: entry.word, pos: entry.pos, french,
    synonyms: entry.syn.slice(0, 6).join("; "), definition, sentence: current?.sentence ?? "",
  });
  updateCount();
  toast(n > 1 ? `Déjà dans ta liste (vu ${n} fois)` : `« ${entry.word} » ajouté`);
  closeSheet();
}

function closeSheet() { $("sheet").hidden = true; }

$("sheet-close").addEventListener("click", closeSheet);
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
$("sheet-search").addEventListener("click", () => {
  current = { ...current, word: $("sheet-word").value.trim() };
  renderSentence();
  search(current.word);
});
$("sheet-word").addEventListener("keydown", (e) => { if (e.key === "Enter") $("sheet-search").click(); });
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

$("export").addEventListener("click", async () => {
  const csv = store.toAnkiCsv();
  const file = new File([csv], "vocabulaire-anki.csv", { type: "text/csv" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Vocabulaire" }); return; } catch { /* annulé */ }
  }
  const a = el("a", { href: URL.createObjectURL(file), download: file.name });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---- Démarrage -----------------------------------------------------------------------------
updateCount();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
// Précharge les modèles en arrière-plan pour que la première photo soit plus rapide
loadModels().catch((e) => ($("status").textContent = "Modèles OCR introuvables : " + e.message));
