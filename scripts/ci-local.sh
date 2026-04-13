#!/usr/bin/env bash
#
# Local CI pipeline using Docker.
#
# Usage:
#   ./scripts/ci-local.sh          # Run full pipeline (lint + typecheck + build)
#   ./scripts/ci-local.sh lint     # Run only lint
#   ./scripts/ci-local.sh build    # Run only build
#   ./scripts/ci-local.sh test     # Run only tests (requires display / xvfb)
#   ./scripts/ci-local.sh all      # Run every stage including tests

set -euo pipefail

STAGE="${1:-ci}"

echo "==> Running local CI stage: ${STAGE}"
echo ""

docker compose build "${STAGE}"
docker compose run --rm "${STAGE}"

echo ""
echo "==> Stage '${STAGE}' passed."
