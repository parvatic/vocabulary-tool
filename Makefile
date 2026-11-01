IMAGE_NAME=mon-notebook
CONTAINER_NAME=notebook
PORT=8888

.PHONY: all build run stop clean

all: build run

build:
	docker build -t $(IMAGE_NAME) .

run:
	@echo "Notebook disponible sur http://localhost:$(PORT)/notebooks/notebook.ipynb"
	docker run -it --rm \
		--name $(CONTAINER_NAME) \
		-p 127.0.0.1:$(PORT):8888 \
		-v $(PWD):/code \
		$(IMAGE_NAME)

stop:
	-docker stop $(CONTAINER_NAME)

clean:
	docker rmi $(IMAGE_NAME)
