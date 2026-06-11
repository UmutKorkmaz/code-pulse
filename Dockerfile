FROM node:18-bullseye-slim AS base

# Install build dependencies for native modules (sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json* ./

RUN npm ci --ignore-scripts && npm rebuild sqlite3

# Copy source
COPY . .

# --------------- lint stage ---------------
FROM base AS lint
RUN npm run lint

# --------------- typecheck stage ---------------
FROM base AS typecheck
RUN npx tsc --noEmit

# --------------- build stage ---------------
FROM base AS build
RUN npm run compile

# --------------- test stage ---------------
FROM build AS test
# VS Code extension tests need a display; use xvfb
RUN apt-get update && \
    apt-get install -y --no-install-recommends xvfb libgtk-3-0 libx11-xcb1 \
    libnss3 libxss1 libasound2 libdrm2 libgbm1 libxshmfence1 && \
    rm -rf /var/lib/apt/lists/*
RUN xvfb-run -a npm test

# --------------- platform stage ---------------
FROM base AS platform
WORKDIR /app/platform
RUN npm ci
RUN npm test

# --------------- ci (default) stage ---------------
FROM base AS ci
RUN npm run lint && \
    npx tsc --noEmit && \
    npm run compile
# Pull a marker from the platform stage so the default ci target
# also builds (and therefore runs) the platform workspace tests.
COPY --from=platform /app/platform/package.json /tmp/.platform-tests-passed
