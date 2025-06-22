### Meural Canvas Image Cropper Makefile ###

# Configuration variables
DOCKER_IMAGE_NAME = meural-cropper
CONTAINER_NAME = meural-cropper
HOST_PORT = 5001
CONTAINER_PORT = 5000
CONFIG_DIR = ./config

# Docker variables
DOCKER = docker
DOCKER_BUILD = $(DOCKER) build
DOCKER_RUN = $(DOCKER) run
DOCKER_STOP = $(DOCKER) stop
DOCKER_RM = $(DOCKER) rm

# Default target when just running 'make' without arguments
.PHONY: default
default: run

# Clean up - stop and remove existing container
.PHONY: clean
clean:
	-$(DOCKER_STOP) $(CONTAINER_NAME) 2>/dev/null
	-$(DOCKER_RM) $(CONTAINER_NAME) 2>/dev/null

# Build the Docker image
.PHONY: build
build:
	@echo "Building Docker image..."
	$(DOCKER_BUILD) -t $(DOCKER_IMAGE_NAME) .

# Run the container (production mode)
.PHONY: run
run: clean build
	@echo "Starting container..."
	$(DOCKER_RUN) -d -p $(HOST_PORT):$(CONTAINER_PORT) \
		-v "$(CONFIG_DIR)":/config \
		--name $(CONTAINER_NAME) \
		$(DOCKER_IMAGE_NAME)
	@echo "Meural Canvas Image Cropper is running at http://localhost:$(HOST_PORT)"
	@echo "Config file location: $(CONFIG_DIR)"

# Run in development mode with app volume mounted for real-time changes
.PHONY: dev
dev: clean build
	@echo "Starting container in development mode..."
	$(DOCKER_RUN) -it -p $(HOST_PORT):$(CONTAINER_PORT) \
		-v "$(CONFIG_DIR)":/config \
		-v "./app":/app \
		-e FLASK_ENV=development \
		-e FLASK_DEBUG=1 \
		--name $(CONTAINER_NAME) \
		$(DOCKER_IMAGE_NAME)

# Show logs of the running container
.PHONY: logs
logs:
	$(DOCKER) logs -f $(CONTAINER_NAME)

# Stop the container
.PHONY: stop
stop:
	-$(DOCKER_STOP) $(CONTAINER_NAME) 2>/dev/null

# Show help
.PHONY: help
help:
	@echo "Meural Canvas Image Cropper Makefile"
	@echo ""
	@echo "Available targets:"
	@echo "  make          : Same as 'make run'"
	@echo "  make build    : Build the Docker image"
	@echo "  make run      : Run the container in production mode"
	@echo "  make dev      : Run in development mode with app directory mounted"
	@echo "  make stop     : Stop the running container"
	@echo "  make clean    : Stop and remove the container"
	@echo "  make logs     : Show logs of the running container"
	@echo "  make help     : Show this help message"
	@echo ""
	@echo "Configuration (edit Makefile to change):"
	@echo "  Docker image name: $(DOCKER_IMAGE_NAME)"
	@echo "  Container name: $(CONTAINER_NAME)"
	@echo "  Port mapping: $(HOST_PORT):$(CONTAINER_PORT)"
	@echo "  Config directory: $(CONFIG_DIR)"
