"""Récupère les modèles PaddleOCR (ONNX) utilisés par la web app, dans docs/models/.

- det.onnx : détecteur de lignes PP-OCRv5 mobile (DBNet), 4,8 Mo
- rec.onnx : reconnaisseur PP-OCRv5 anglais (SVTR + CTC), 7,8 Mo — entrée 48 px de haut
- keys.txt : dictionnaire des caractères du reconnaisseur

Conversions ONNX publiées sur Hugging Face (licence Apache 2.0, comme PaddleOCR). Les révisions
sont figées et chaque fichier est vérifié par son empreinte SHA-256.

Usage : python -m vocab.fetch_models
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "models"

MONKT = "https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65"
NAKAMURA = "https://huggingface.co/nakamura196/ppocrv5-mobile-web-onnx/resolve/dc7e2271c00d961a4c0a38dcebe23beb735ba33e"

MODELS = [
    ("det.onnx", f"{NAKAMURA}/PP-OCRv5_mobile_det.onnx",
     "6bdf743af375b13fbbeeb47a91a40063af5bfb7a7f197f6df8cb990dc827e5d6"),
    ("rec.onnx", f"{MONKT}/languages/english/rec.onnx",
     "4e16deb22c4da6468bdca539b2cd3c8687825538b67109177c47d359ab994cd7"),
    ("keys.txt", f"{MONKT}/languages/english/dict.txt",
     "e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6"),
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, url, expected in MODELS:
        dest = OUT / name
        if dest.exists() and sha256(dest) == expected:
            print(f"{name} : déjà à jour", file=sys.stderr)
            continue
        print(f"{name} : téléchargement…", file=sys.stderr)
        tmp = dest.with_suffix(dest.suffix + ".part")
        req = urllib.request.Request(url, headers={"User-Agent": "vocabulary-tool"})
        with urllib.request.urlopen(req) as r, open(tmp, "wb") as f:
            while block := r.read(1 << 20):
                f.write(block)
        got = sha256(tmp)
        if got != expected:
            tmp.unlink()
            sys.exit(f"{name} : empreinte inattendue ({got}), fichier rejeté")
        tmp.replace(dest)
        print(f"{name} : OK ({dest.stat().st_size / 1e6:.1f} Mo)", file=sys.stderr)


if __name__ == "__main__":
    main()
