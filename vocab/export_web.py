"""Exporte un dictionnaire compact pour la web app (téléphone).

Part de data/en_fr.sqlite (construit par `make dict`) et écrit docs/dict/<xx>.json,
un petit fichier par préfixe de deux lettres. Le téléphone ne télécharge que le
fichier du mot cherché, puis le garde en cache hors ligne.

On ne garde que :
  * les entrées qui ont au moins une traduction française ;
  * quelques définitions anglaises courtes par entrée ;
  * les synonymes (Wiktionnaire + WordNet, précalculés ici : pas de WordNet sur le téléphone) ;
  * les formes fléchies (« ran » → « run ») dont le lemme est gardé.

Usage : python -m vocab.export_web
"""

import argparse
import json
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

from .build_dict import DEFAULT_DB
from .dictionary import _TECH_TAGS
from . import synonyms as wn_syn

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "docs" / "dict"
MAX_GLOSSES = 4
MAX_SYNONYMS = 10


def shard_key(word: str) -> str:
    """Préfixe de deux lettres, en minuscules ; tout le reste va dans « _ »."""
    w = word.lower()
    k = "".join(c if "a" <= c <= "z" else "_" for c in w[:2])
    return (k + "_")[:2] if k else "__"


def compact_entry(word: str, pos: str, data: dict) -> dict | None:
    fr: dict[str, list[str]] = {}
    for t in data["fr"]:
        lst = fr.setdefault(t["sense"], [])
        if t["word"] not in lst:
            lst.append(t["word"])
    if not fr:
        return None
    syns = list(data["synonyms"])
    for s in data["senses"]:
        syns += s["synonyms"]
    syns += wn_syn.synonyms(word, pos)
    seen, out_syns = {word.lower()}, []
    for s in syns:
        if s.lower() not in seen:
            seen.add(s.lower())
            out_syns.append(s)
    return {
        "pos": pos,
        "gloss": [s["gloss"] for s in data["senses"][:MAX_GLOSSES]],
        "fr": fr,
        "syn": out_syns[:MAX_SYNONYMS],
    }


def export(db_path: Path, out_dir: Path) -> None:
    if not db_path.exists():
        sys.exit(f"{db_path} introuvable : lance d'abord `make dict`.")
    if not wn_syn.AVAILABLE:
        print("Attention : WordNet indisponible, synonymes du Wiktionnaire seulement.", file=sys.stderr)
    con = sqlite3.connect(db_path)
    shards: dict[str, dict] = defaultdict(lambda: {"e": {}, "f": {}})
    kept: set[str] = set()

    n = 0
    for word, pos, data in con.execute("SELECT word, pos, data FROM entries"):
        e = compact_entry(word, pos, json.loads(data))
        if e:
            shards[shard_key(word)]["e"].setdefault(word, []).append(e)
            kept.add(word)
            n += 1
    n_forms = 0
    for form, lemma, pos, tags in con.execute("SELECT form, lemma, pos, tags FROM forms"):
        if lemma in kept and form != lemma:
            lst = shards[shard_key(form)]["f"].setdefault(form, [])
            item = [lemma, pos, " ".join(t for t in (tags or "").split() if t not in _TECH_TAGS)]
            if item not in lst:
                lst.append(item)
                n_forms += 1

    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.json"):
        old.unlink()
    total = 0
    for key, content in shards.items():
        p = out_dir / f"{key}.json"
        p.write_text(json.dumps(content, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        total += p.stat().st_size
    print(f"{n:,} entrées, {n_forms:,} formes, {len(shards)} fichiers, "
          f"{total / 1e6:.1f} Mo → {out_dir}", file=sys.stderr)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    a = p.parse_args()
    export(a.db, a.out)


if __name__ == "__main__":
    main()
