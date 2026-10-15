#!/usr/bin/env bash
# `docker compose` for this stack, with the right compose file, .env and deploy state.
#
#   ./scripts/dc.sh ps
#   ./scripts/dc.sh logs -f --since 10m app_blue
#   ./scripts/dc.sh exec postgres psql -U relay
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
dc "$@"
