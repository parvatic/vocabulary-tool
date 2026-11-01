"""Construit un dictionnaire anglais → français local (SQLite) à partir du Wiktionnaire.

Source : l'extraction JSONL du Wiktionnaire anglais publiée par kaikki.org (projet
wiktextract). Le fichier est lu en streaming et filtré à la volée : on ne garde que
les entrées anglaises, avec pour chacune ses sens (définitions en anglais), ses
synonymes et ses traductions françaises. Les formes fléchies (« ran », « mice »…)
sont gardées dans une table à part qui pointe vers leur lemme.

Usage (dans le conteneur Docker, une seule fois, ~15-30 min selon la connexion) :
    python -m vocab.build_dict
    python -m vocab.build_dict --input fichier_deja_telecharge.jsonl
"""

import argparse
import gzip
import io
import json
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

DEFAULT_URL = "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl"
DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "en_fr.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    word TEXT NOT NULL,
    pos  TEXT NOT NULL,
    data TEXT NOT NULL          -- JSON : {"senses": [...], "fr": [...], "synonyms": [...]}
);
CREATE TABLE IF NOT EXISTS forms (
    form  TEXT NOT NULL,        -- forme fléchie, ex. "ran"
    lemma TEXT NOT NULL,        -- lemme, ex. "run"
    pos   TEXT NOT NULL,
    tags  TEXT                  -- ex. "past"
);
"""
INDEXES = """
CREATE INDEX IF NOT EXISTS idx_entries_word ON entries(word);
CREATE INDEX IF NOT EXISTS idx_forms_form ON forms(form);
"""


def _open_lines(source: str):
    """Itère sur les lignes d'un fichier local ou d'une URL, compressé (.gz) ou non."""
    if source.startswith(("http://", "https://")):
        req = urllib.request.Request(source, headers={"User-Agent": "vocabulary-tool"})
        raw = urllib.request.urlopen(req)
    else:
        raw = open(source, "rb")
    if source.endswith(".gz"):
        raw = gzip.GzipFile(fileobj=raw)
    return io.TextIOWrapper(raw, encoding="utf-8")


def _words(items) -> list[str]:
    seen, out = set(), []
    for it in items or []:
        w = (it.get("word") or "").strip()
        if w and w not in seen:
            seen.add(w)
            out.append(w)
    return out


def _french(translations) -> list[dict]:
    """Garde les traductions françaises : [{"sense": "...", "word": "..."}]."""
    out = []
    for t in translations or []:
        if t.get("code") == "fr" or t.get("lang") == "French":
            if t.get("word"):
                out.append({"sense": t.get("sense") or "", "word": t["word"]})
    return out


def parse_entry(obj: dict):
    """Transforme une ligne wiktextract en (entrée, formes fléchies).

    Retourne (None, forms) si l'entrée ne contient que des renvois vers un lemme.
    """
    if obj.get("lang_code", "en") != "en" or not obj.get("word"):
        return None, []
    word, pos = obj["word"], obj.get("pos", "")

    senses, forms = [], []
    fr = _french(obj.get("translations"))
    for s in obj.get("senses") or []:
        targets = (s.get("form_of") or []) + (s.get("alt_of") or [])
        if targets:
            for t in targets:
                if t.get("word"):
                    forms.append((word, t["word"], pos, " ".join(s.get("tags") or [])))
            continue
        glosses = s.get("glosses") or []
        if not glosses:
            continue
        senses.append({
            "gloss": glosses[-1],                 # la plus précise ; [0] est souvent le parent
            "tags": s.get("tags") or [],
            "synonyms": _words(s.get("synonyms")),
        })
        fr += _french(s.get("translations"))

    if not senses:
        return None, forms
    entry = {
        "word": word,
        "pos": pos,
        "senses": senses,
        "fr": fr,
        "synonyms": _words(obj.get("synonyms")),
    }
    return entry, forms


def build(source: str, db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = db_path.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)

    n_lines = n_entries = n_forms = 0
    batch_e, batch_f = [], []
    start = time.time()
    for line in _open_lines(source):
        n_lines += 1
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        entry, forms = parse_entry(obj)
        if entry:
            batch_e.append((entry["word"], entry["pos"],
                            json.dumps({k: entry[k] for k in ("senses", "fr", "synonyms")},
                                       ensure_ascii=False)))
        batch_f += forms
        if len(batch_e) >= 5000 or len(batch_f) >= 5000:
            con.executemany("INSERT INTO entries VALUES (?,?,?)", batch_e)
            con.executemany("INSERT INTO forms VALUES (?,?,?,?)", batch_f)
            n_entries += len(batch_e)
            n_forms += len(batch_f)
            batch_e, batch_f = [], []
        if n_lines % 100_000 == 0:
            print(f"{n_lines:>9,} lignes lues · {n_entries:,} entrées · {n_forms:,} formes "
                  f"· {time.time() - start:.0f}s", file=sys.stderr)
    con.executemany("INSERT INTO entries VALUES (?,?,?)", batch_e)
    con.executemany("INSERT INTO forms VALUES (?,?,?,?)", batch_f)
    n_entries += len(batch_e)
    n_forms += len(batch_f)
    con.executescript(INDEXES)
    con.commit()
    con.close()
    tmp.replace(db_path)
    print(f"Terminé : {n_entries:,} entrées, {n_forms:,} formes fléchies → {db_path}",
          file=sys.stderr)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--input", default=DEFAULT_URL, help="URL ou fichier JSONL (.jsonl ou .jsonl.gz)")
    p.add_argument("--db", type=Path, default=DEFAULT_DB, help="Fichier SQLite de sortie")
    args = p.parse_args()
    build(args.input, args.db)


if __name__ == "__main__":
    main()
