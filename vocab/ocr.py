"""OCR d'une page de livre : chaque mot avec sa boîte, sa confiance et sa phrase.

Tesseract (`image_to_data`) renvoie une ligne par mot, rangée dans une hiérarchie
bloc → paragraphe → ligne → mot. On s'en sert pour :
  * retrouver le mot sous un clic (`word_at`) ;
  * recoller les mots coupés en fin de ligne (« favo- / risé ») ;
  * reconstituer la phrase qui contient un mot (`sentence_of`).
"""

from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
import pytesseract

# On vise des lettres d'environ 30 px de haut pour Tesseract.
_TARGET_LONG_SIDE = 3000
_SENTENCE_END = (".", "!", "?", "…", ".”", "!”", "?”", ".\"", "!\"", "?\"")
_HYPHENS = ("-", "‐", "‑", "¬")


@dataclass
class Word:
    text: str                       # texte tel que lu par l'OCR
    conf: float                     # confiance Tesseract, 0-100
    box: tuple[int, int, int, int]  # (x, y, largeur, hauteur) dans l'image d'origine
    line: tuple[int, int, int]      # (bloc, paragraphe, ligne)
    full: str = ""                  # mot complet si coupé en fin de ligne, sinon = text
    index: int = 0                  # position dans la page
    parts: list[int] = field(default_factory=list)  # index des morceaux d'un mot coupé

    def __post_init__(self):
        self.full = self.full or self.text


def load_image(path_or_array) -> np.ndarray:
    if isinstance(path_or_array, np.ndarray):
        return path_or_array
    img = cv2.imread(str(Path(path_or_array)))
    if img is None:
        raise FileNotFoundError(path_or_array)
    return img


def preprocess(img: np.ndarray) -> tuple[np.ndarray, float]:
    """Niveaux de gris + mise à l'échelle. Renvoie (image, facteur d'échelle).

    Une photo de téléphone en pleine résolution n'a besoin que du passage en gris ;
    une petite image est agrandie (ce qui aide, mais ne remplace pas une vraie photo).
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    scale = min(3.0, _TARGET_LONG_SIDE / max(gray.shape))
    if scale > 1.2:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    else:
        scale = 1.0
    return gray, scale


def ocr_words(image, lang: str = "eng", psm: int = 3) -> list[Word]:
    """Lit la page et renvoie les mots dans l'ordre de lecture."""
    img = load_image(image)
    proc, scale = preprocess(img)
    d = pytesseract.image_to_data(proc, lang=lang, config=f"--oem 3 --psm {psm}",
                                  output_type=pytesseract.Output.DICT)
    words: list[Word] = []
    for i, text in enumerate(d["text"]):
        if not text or not text.strip():
            continue
        x, y, w, h = (int(round(d[k][i] / scale)) for k in ("left", "top", "width", "height"))
        words.append(Word(
            text=text.strip(),
            conf=float(d["conf"][i]),
            box=(x, y, w, h),
            line=(d["block_num"][i], d["par_num"][i], d["line_num"][i]),
            index=len(words),
        ))
    _join_hyphenated(words)
    return words


def _join_hyphenated(words: list[Word]) -> None:
    """« favo- » en fin de ligne + « risé » en début de ligne suivante → « favorisé »."""
    for a, b in zip(words, words[1:]):
        if a.line != b.line and a.text.endswith(_HYPHENS) and len(a.text) > 1 and b.text[:1].isalpha():
            full = a.text.rstrip("".join(_HYPHENS)) + b.text
            a.full = b.full = full
            a.parts = b.parts = [a.index, b.index]


def word_at(words: list[Word], x: float, y: float, margin: int = 4) -> Word | None:
    """Le mot dont la boîte contient le point (x, y), en coordonnées de l'image d'origine."""
    best, best_d = None, float("inf")
    for w in words:
        bx, by, bw, bh = w.box
        if bx - margin <= x <= bx + bw + margin and by - margin <= y <= by + bh + margin:
            d = abs(x - (bx + bw / 2)) + abs(y - (by + bh / 2))
            if d < best_d:
                best, best_d = w, d
    return best


def annotate(image, words: list[Word], highlight: Word | None = None):
    """Image PIL avec la boîte de chaque mot : vert = confiance ≥ 80, orange = 60-80, rouge < 60."""
    from PIL import Image
    img = load_image(image).copy()
    for w in words:
        x, y, bw, bh = w.box
        color = (0, 160, 0) if w.conf >= 80 else (0, 140, 255) if w.conf >= 60 else (0, 0, 220)
        cv2.rectangle(img, (x, y), (x + bw, y + bh), color, 1)
    if highlight:
        x, y, bw, bh = highlight.box
        cv2.rectangle(img, (x - 2, y - 2), (x + bw + 2, y + bh + 2), (255, 0, 0), 3)
    return Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))


def find(words: list[Word], text: str) -> list[Word]:
    """Les mots de la page qui correspondent à `text` (insensible à la casse et à la ponctuation)."""
    from .dictionary import clean_token
    target = clean_token(text).lower()
    return [w for w in words if clean_token(w.full).lower() == target]


def page_text(words: list[Word]) -> str:
    """Texte de la page, mots coupés recollés, un paragraphe par ligne vide."""
    out, prev = [], None
    for w in words:
        if w.parts and w.index != w.parts[0]:
            continue  # seconde moitié d'un mot coupé, déjà écrite
        if prev is not None:
            out.append("\n\n" if prev.line[:2] != w.line[:2] else " ")
        out.append(w.full)
        prev = w
    return "".join(out)


def sentence_of(words: list[Word], word: Word) -> str:
    """La phrase qui contient `word` (bornée par . ! ? ou un changement de paragraphe)."""
    i = word.parts[0] if word.parts else word.index
    para = word.line[:2]

    start = i
    while start > 0:
        prev = words[start - 1]
        if prev.line[:2] != para or prev.text.endswith(_SENTENCE_END):
            break
        start -= 1
    end = i
    while end < len(words) - 1 and not words[end].text.endswith(_SENTENCE_END):
        if words[end + 1].line[:2] != para:
            break
        end += 1
    return page_text(words[start:end + 1])
