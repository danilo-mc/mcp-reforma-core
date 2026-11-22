# syntax=docker/dockerfile:1
#
# mcp-reforma server image.
# BUILD CONTEXT = REPOSITORY ROOT (so that rates/ can be baked into the image):
#   docker build -f server/Dockerfile -t mcp-reforma-server .
# docker-compose: build: { context: ., dockerfile: server/Dockerfile }

ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ARG BUILD_TIME=""
ARG GIT_SHA=""
ARG UPSTREAM_REGULAR_SHA=""
ARG UPSTREAM_SIMPLES_SHA=""
LABEL org.opencontainers.image.title="mcp-reforma-server" \
      org.opencontainers.image.description="Servidor MCP independente para a calculadora oficial da Reforma Tributária (não oficial)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      br.mcp-reforma.upstream.regular="${UPSTREAM_REGULAR_SHA}" \
      br.mcp-reforma.upstream.simples="${UPSTREAM_SIMPLES_SHA}"

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=3000 \
    RATES_DIR=/app/rates \
    BUILD_TIME=${BUILD_TIME} \
    UPSTREAM_REGULAR_SHA=${UPSTREAM_REGULAR_SHA} \
    UPSTREAM_SIMPLES_SHA=${UPSTREAM_SIMPLES_SHA}

WORKDIR /app/server
COPY --from=build --chown=root:root /app/server/package.json ./package.json
COPY --from=build --chown=root:root /app/server/node_modules ./node_modules
COPY --from=build --chown=root:root /app/server/dist ./dist
COPY --chown=root:root rates /app/rates

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
