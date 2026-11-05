#!/usr/bin/env bash
# Loads the secrets from ~/.config/ponder-chat and starts Ponder Chat from its build
# (npm run build). Workflow runs live in Postgres, so a restart picks up replies in progress.
set -a
. ~/.config/ponder-chat/.env
set +a
export WORKFLOW_TARGET_WORLD=@workflow/world-postgres
export WORKFLOW_POSTGRES_URL=${WORKFLOW_POSTGRES_URL:-$DATABASE_URL}
# The server stops the worker itself on SIGTERM (server/startup.ts).
export WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1
export PORT=${PORT:-3500}
# Loopback only: the workflow's flow route has no authentication (nitro.config.ts).
export HOST=${HOST:-127.0.0.1}
exec node .output/server/index.mjs
