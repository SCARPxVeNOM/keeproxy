# keeproxy-viewer: the watch-only console backend (server/viewer.ts).
# No keys, no wallet, no proof server: it only reads the indexer.
# Built from the folder that scripts/stage-viewer.sh assembles.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY contract contract
COPY src src
COPY server/viewer.ts server/viewer.ts
ENV NODE_ENV=production HOST=0.0.0.0 NODE_OPTIONS=--max-old-space-size=192
CMD ["npx", "vite-node", "server/viewer.ts"]
