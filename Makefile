IMAGE_NAME=mon-notebook
CONTAINER_NAME=notebook
PORT=8888

.PHONY: all build run stop clean dict web-dict web-models web serve

all: build run

build:
	docker build -t $(IMAGE_NAME) .

run:
	@echo "JupyterLab disponible sur http://localhost:$(PORT)/lab (fichiers synchronisés avec $(PWD))"
	docker run -it --rm \
		--name $(CONTAINER_NAME) \
		-p 127.0.0.1:$(PORT):8888 \
		-v $(PWD):/code \
		$(IMAGE_NAME)

stop:
	-docker stop $(CONTAINER_NAME)

clean:
	docker rmi $(IMAGE_NAME)

# Construit une fois le dictionnaire anglais → français (Wiktionnaire via kaikki.org)
# dans data/en_fr.sqlite. Téléchargement de quelques Go en streaming, ~15-30 min.
dict:
	docker run --rm -v $(PWD):/code $(IMAGE_NAME) python -m vocab.build_dict

# ---- Web app (docs/) : photo → mot → vocabulaire, sur iPhone et Android -----------------
# Dictionnaire compact pour le téléphone (docs/dict/, ~30 Mo), avec synonymes WordNet
web-dict:
	docker run --rm -v $(PWD):/code $(IMAGE_NAME) python -m vocab.export_web

# Modèles PaddleOCR (PP-OCRv4 mobile, ONNX) dans docs/models/
web-models:
	docker run --rm -v $(PWD):/code $(IMAGE_NAME) python -m vocab.fetch_models

web: web-dict web-models

# Sert l'app sur le réseau local : ouvre http://<ip-du-mac>:8000 sur ton téléphone (même Wi-Fi)
serve:
	@echo "Sur ce Mac : http://localhost:8000 — sur ton téléphone : http://$$(ipconfig getifaddr en0 2>/dev/null || echo IP-DU-MAC):8000"
	cd docs && python3 -m http.server 8000
