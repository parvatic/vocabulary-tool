"""Table de vocabulaire (SQLite) avec export CSV pour Anki."""

import csv
import sqlite3
from datetime import datetime
from pathlib import Path

DEFAULT_TABLE = Path(__file__).resolve().parent.parent / "data" / "vocabulary.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS vocabulary (
    id          INTEGER PRIMARY KEY,
    word        TEXT NOT NULL,       -- forme rencontrée dans le texte, ex. "ran"
    lemma       TEXT NOT NULL,       -- entrée de dictionnaire, ex. "run"
    pos         TEXT,
    french      TEXT NOT NULL,       -- traduction(s) choisie(s), séparées par « ; »
    synonyms    TEXT,                -- synonymes anglais, séparés par « ; »
    definition  TEXT,                -- définition anglaise du sens choisi
    sentence    TEXT,                -- phrase du livre
    source      TEXT,                -- livre / page
    times_seen  INTEGER NOT NULL DEFAULT 1,
    added_at    TEXT NOT NULL,
    UNIQUE (lemma, pos, french)
);
"""


class VocabTable:
    def __init__(self, path: Path | str = DEFAULT_TABLE):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.con = sqlite3.connect(path, check_same_thread=False)
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)

    def add(self, *, word: str, lemma: str, french: list[str] | str, pos: str = "",
            synonyms: list[str] | str = "", definition: str = "", sentence: str = "",
            source: str = "") -> dict:
        """Ajoute un mot ; s'il existe déjà (même lemme, nature et traduction), incrémente `times_seen`."""
        join = lambda v: "; ".join(v) if isinstance(v, (list, tuple)) else (v or "")
        row = dict(word=word, lemma=lemma, pos=pos, french=join(french), synonyms=join(synonyms),
                   definition=definition, sentence=sentence, source=source,
                   added_at=datetime.now().isoformat(timespec="seconds"))
        self.con.execute(
            """INSERT INTO vocabulary (word, lemma, pos, french, synonyms, definition, sentence, source, added_at)
               VALUES (:word, :lemma, :pos, :french, :synonyms, :definition, :sentence, :source, :added_at)
               ON CONFLICT (lemma, pos, french) DO UPDATE SET times_seen = times_seen + 1""",
            row,
        )
        self.con.commit()
        return dict(self.con.execute(
            "SELECT * FROM vocabulary WHERE lemma = ? AND pos = ? AND french = ?",
            (lemma, pos, row["french"])).fetchone())

    def all(self) -> list[dict]:
        return [dict(r) for r in self.con.execute(
            "SELECT * FROM vocabulary ORDER BY times_seen DESC, added_at DESC")]

    def delete(self, row_id: int) -> None:
        self.con.execute("DELETE FROM vocabulary WHERE id = ?", (row_id,))
        self.con.commit()

    def export_anki(self, path: Path | str) -> Path:
        """CSV à importer dans Anki : recto = mot anglais (+ phrase), verso = traduction (+ synonymes)."""
        path = Path(path)
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            for r in self.all():
                front = r["lemma"] + (f"<br><i>{r['sentence']}</i>" if r["sentence"] else "")
                back = r["french"] + (f"<br><small>≈ {r['synonyms']}</small>" if r["synonyms"] else "")
                w.writerow([front, back])
        return path
