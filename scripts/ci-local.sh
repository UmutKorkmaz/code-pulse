#!/usr/bin/env bash
#
# Local CI pipeline using Docker.
#
# Each stage maps to a Dockerfile target; the checks run during the image
# build, so a failing check fails the build (no container needs to run).
#
# Usage:
#   ./scripts/ci-local.sh            # Run default ci stage (lint + typecheck + build + platform tests)
#   ./scripts/ci-local.sh lint       # Run only lint
#   ./scripts/ci-local.sh typecheck  # Run only typecheck
#   ./scripts/ci-local.sh build      # Run only build
#   ./scripts/ci-local.sh test       # Run only extension tests (xvfb inside the image)
#   ./scripts/ci-local.sh platform   # Run only the platform workspace tests
#   ./scripts/ci-local.sh all        # Run every stage including tests

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

run_stage() {
    local stage="$1"
    echo "==> Running local CI stage: ${stage}"
    echo ""
    docker build --target "${stage}" --tag "codepulse-ci:${stage}" .
    echo ""
    echo "==> Stage '${stage}' passed."
}

STAGE="${1:-ci}"

case "${STAGE}" in
    ci|lint|typecheck|build|test|platform)
        run_stage "${STAGE}"
        ;;
    all)
        for stage in lint typecheck build test platform; do
            run_stage "${stage}"
        done
        ;;
    *)
        echo "Unknown stage: ${STAGE}" >&2
        echo "Valid stages: ci, lint, typecheck, build, test, platform, all" >&2
        exit 1
        ;;
esac
