// Liste de vocabulaire stockée sur le téléphone (localStorage), avec export CSV pour Anki.
const KEY = "vocabulary-tool:list";

export function all() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}

function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { alert("Impossible d'enregistrer : " + e.message); }
}

/** Ajoute un mot ; même lemme + nature + traduction déjà présent → compteur « vu N fois ». */
export function add(item) {
  const list = all();
  const same = list.find((x) => x.lemma === item.lemma && x.pos === item.pos && x.french === item.french);
  if (same) { same.timesSeen += 1; same.sentence = same.sentence || item.sentence; }
  else list.unshift({ ...item, id: Date.now(), timesSeen: 1, addedAt: new Date().toISOString() });
  save(list);
  return same ? same.timesSeen : 1;
}

export function remove(id) { save(all().filter((x) => x.id !== id)); }

const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

/** CSV Anki : recto = mot anglais + phrase ; verso = traduction + synonymes (HTML autorisé). */
export function toAnkiCsv() {
  return all().map((r) => {
    const front = r.lemma + (r.sentence ? `<br><i>${r.sentence}</i>` : "");
    const back = r.french + (r.synonyms ? `<br><small>≈ ${r.synonyms}</small>` : "");
    return [front, back].map(csvCell).join(",");
  }).join("\n");
}
