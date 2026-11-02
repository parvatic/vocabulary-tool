// Liste de vocabulaire stockée sur le téléphone.
//
// - IndexedDB est le stockage principal ; une copie est gardée dans localStorage en secours.
// - L'app demande au navigateur un stockage « persistant » pour qu'il ne l'efface pas de lui-même.
// - La liste est gardée en mémoire : lecture synchrone, écriture immédiate dans les deux stockages.
// - Sauvegarde / restauration par fichier JSON (changement de téléphone, Safari ↔ écran d'accueil).
const KEY = "vocabulary-tool:list";
const DB_NAME = "vocabulary-tool";
const STORE = "kv";

let list = [];
let persisted = false;

// ---- IndexedDB ---------------------------------------------------------------------------
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const idbGet = () => idb("readonly", (s) => s.get(KEY));
const idbSet = (value) => idb("readwrite", (s) => s.put(value, KEY));

// ---- Fusion (migration, restauration) -------------------------------------------------------
const keyOf = (x) => `${x.lemma}\u0000${x.pos}\u0000${x.french}`;

function merge(...sources) {
  const byKey = new Map();
  for (const src of sources) {
    if (!Array.isArray(src)) continue;
    for (const item of src) {
      if (!item || !item.lemma) continue;
      const k = keyOf(item);
      const prev = byKey.get(k);
      if (!prev) byKey.set(k, { ...item });
      else {
        prev.timesSeen = Math.max(prev.timesSeen || 1, item.timesSeen || 1);
        prev.sentence = prev.sentence || item.sentence;
        prev.addedAt = [prev.addedAt, item.addedAt].filter(Boolean).sort()[0];
      }
    }
  }
  return [...byKey.values()].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

// ---- Écriture --------------------------------------------------------------------------------
let warned = false;
function save() {
  const json = JSON.stringify(list);
  try { localStorage.setItem(KEY, json); } catch { /* quota ou mode privé : IndexedDB suffit */ }
  idbSet(list).catch((e) => {
    if (!warned) { warned = true; alert("Impossible d'enregistrer la liste : " + (e?.message || e)); }
  });
}

/** À appeler au démarrage : charge la liste (IndexedDB + secours) et demande le stockage persistant. */
export async function init() {
  let fromIdb = null, fromLs = null;
  try { fromIdb = await idbGet(); } catch { /* IndexedDB indisponible */ }
  try { fromLs = JSON.parse(localStorage.getItem(KEY)); } catch { /* rien */ }
  list = merge(fromIdb, fromLs);
  if (list.length) save(); // migration : l'ancienne liste localStorage passe dans IndexedDB
  try {
    if (navigator.storage?.persist) persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch { /* non supporté */ }
  return { count: list.length, persisted };
}

export function isPersisted() { return persisted; }

export function all() { return list; }

/** Ajoute un mot ; même lemme + nature + traduction déjà présent → compteur « vu N fois ». */
export function add(item) {
  const same = list.find((x) => keyOf(x) === keyOf(item));
  if (same) { same.timesSeen += 1; same.sentence = same.sentence || item.sentence; }
  else list.unshift({ ...item, id: Date.now(), timesSeen: 1, addedAt: new Date().toISOString() });
  save();
  return same ? same.timesSeen : 1;
}

export function remove(id) { list = list.filter((x) => x.id !== id); save(); }

// ---- Sauvegarde / restauration ------------------------------------------------------------------
export function toBackupJson() {
  return JSON.stringify({ app: "vocabulary-tool", version: 1, exportedAt: new Date().toISOString(), words: list }, null, 1);
}

/** Fusionne une sauvegarde JSON dans la liste ; renvoie le nombre de mots ajoutés. */
export function restoreFromJson(text) {
  const data = JSON.parse(text);
  const words = Array.isArray(data) ? data : data.words;
  if (!Array.isArray(words)) throw new Error("fichier de sauvegarde invalide");
  const before = list.length;
  list = merge(list, words);
  save();
  return list.length - before;
}

const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

/** CSV Anki : recto = mot anglais + phrase ; verso = traduction + synonymes (HTML autorisé). */
export function toAnkiCsv() {
  return list.map((r) => {
    const front = r.lemma + (r.sentence ? `<br><i>${r.sentence}</i>` : "");
    const back = r.french + (r.synonyms ? `<br><small>≈ ${r.synonyms}</small>` : "");
    return [front, back].map(csvCell).join(",");
  }).join("\n");
}
