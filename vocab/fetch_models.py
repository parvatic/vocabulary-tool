"""Récupère les modèles PaddleOCR (PP-OCRv4 mobile) au format ONNX pour la web app.

Les modèles officiels PaddleOCR sont au format Paddle ; le projet RapidOCR les
publie convertis en ONNX dans son paquet PyPI `rapidocr_onnxruntime`. On télécharge
ce paquet (sans l'installer), on en extrait :
  * le détecteur de texte (DBNet)        → docs/models/det.onnx
  * le reconnaisseur (CRNN/SVTR + CTC)   → docs/models/rec.onnx
  * la table des caractères du reconnaisseur → docs/models/keys.txt

Usage : python -m vocab.fetch_models
"""

import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "models"
PACKAGE = "rapidocr_onnxruntime"


def _keys_from_metadata(onnx_path: Path) -> list[str] | None:
    """Les modèles rec de RapidOCR embarquent leurs caractères dans les métadonnées ONNX."""
    try:
        import onnxruntime as ort
    except ImportError:
        return None
    meta = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"]) \
        .get_modelmeta().custom_metadata_map
    chars = meta.get("character")
    return chars.splitlines() if chars else None


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        print(f"Téléchargement de {PACKAGE}…", file=sys.stderr)
        subprocess.run([sys.executable, "-m", "pip", "download", PACKAGE, "--no-deps",
                        "--only-binary=:all:", "-d", str(tmp), "-q"], check=True)
        wheel = next(tmp.glob("*.whl"))
        with zipfile.ZipFile(wheel) as z:
            z.extractall(tmp / "pkg")
        files = list((tmp / "pkg").rglob("*"))
        onnx = [f for f in files if f.suffix == ".onnx"]
        det = next((f for f in onnx if "det" in f.name), None)
        rec = next((f for f in onnx if "rec" in f.name), None)
        if not det or not rec:
            sys.exit(f"Modèles introuvables dans {wheel.name} : {[f.name for f in onnx]}")
        shutil.copy(det, OUT / "det.onnx")
        shutil.copy(rec, OUT / "rec.onnx")

        keys = _keys_from_metadata(rec)
        if keys is None:
            txt = next((f for f in files if f.suffix == ".txt" and "key" in f.name.lower()), None)
            if not txt:
                sys.exit("Table des caractères introuvable (ni métadonnées ONNX, ni fichier *keys*.txt).")
            keys = txt.read_text(encoding="utf-8").splitlines()
        (OUT / "keys.txt").write_text("\n".join(keys) + "\n", encoding="utf-8")
        print(f"{det.name} → det.onnx, {rec.name} → rec.onnx, {len(keys)} caractères → {OUT}",
              file=sys.stderr)


if __name__ == "__main__":
    main()
