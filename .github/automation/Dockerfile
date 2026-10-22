FROM node:26.12.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --allow-scripts=opencode-ai,pnpm pnpm@12.14.0 opencode-ai@1.19.3 \
    && opencode --version && pnpm --version
WORKDIR /opt/deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile && chmod -R a+rX /opt/deps
WORKDIR /work
USER node
