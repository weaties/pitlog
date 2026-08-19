# PitLog — developer entry points.
# `make dev` is the one documented bootstrap sequence (see README.md).

SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.env:
	@cp .env.example .env && echo "created .env from .env.example"

.PHONY: install
install: .env ## Install workspace dependencies
	npm install

.PHONY: up
up: .env ## Start local Postgres and wait for it to be healthy
	docker compose up -d --wait postgres

.PHONY: down
down: ## Stop local Postgres (keeps the volume)
	docker compose down

.PHONY: nuke
nuke: ## Stop local Postgres and DELETE its data volume
	docker compose down -v

.PHONY: migrate
migrate: ## Apply database migrations
	npm run db:migrate

.PHONY: seed
seed: ## Reset and reseed the database (demo team + fixture 8h race)
	npm run db:seed

.PHONY: dev
dev: install up migrate seed ## Bootstrap everything and run the app (api + web)
	npx concurrently -n api,web -c blue,magenta \
	  "npm run dev -w @pitlog/api" \
	  "npm run dev -w @pitlog/web"

.PHONY: run
run: ## Run api + web without re-bootstrapping
	npx concurrently -n api,web -c blue,magenta \
	  "npm run dev -w @pitlog/api" \
	  "npm run dev -w @pitlog/web"

.PHONY: test
test: ## Unit tests (vitest)
	npm run test

.PHONY: e2e
e2e: ## Browser smoke tests (playwright)
	npm run test:e2e

.PHONY: typecheck
typecheck: ## Typecheck every workspace
	npm run typecheck

.PHONY: lint
lint: ## Lint + format check
	npm run lint

.PHONY: fix
fix: ## Autofix lint + formatting
	npm run lint:fix

.PHONY: check
check: typecheck lint test ## Everything CI runs, minus the browser smoke test
