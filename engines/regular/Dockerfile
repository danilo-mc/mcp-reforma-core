# syntax=docker/dockerfile:1.7
#
# engine-regular — Calculadora RTC, regime regular (ReceitaFederal/calculadora-rtc-regime-regular)
#
# Builds the OFFICIAL upstream code at a pinned commit. No patches are applied to the
# upstream sources; any workaround lives in this file and is commented.
#
#   docker build --build-arg UPSTREAM_SHA=<sha> -t mcp-reforma/engine-regular engines/regular
#
# Notes
# - Upstream unit/integration tests are NOT run in the image build (-DskipTests,
#   -Djacoco.skip=true) to keep builds fast; they are the upstream's responsibility and
#   run in its own CI. Our golden tests exercise the running image instead.
# - The SQLite database is generated at build time with Flyway from the upstream
#   `flyway/` folder, exactly as documented in the upstream README (step 3), and baked
#   into the image (read-only at runtime, `mode=ro` in application-offline.yml).

ARG UPSTREAM_REPO=ReceitaFederal/calculadora-rtc-regime-regular
ARG UPSTREAM_SHA=f1eebd7ce3157423b1a6aaca7dc1d6c3395452c4
# Human-readable version (output of `git describe --tags` at UPSTREAM_SHA). Only used for labels.
ARG UPSTREAM_VERSION=1.7.2-1-gf1eebd7

############################
# 1. Fetch upstream sources
############################
FROM alpine:3.22 AS src
ARG UPSTREAM_REPO
ARG UPSTREAM_SHA
RUN apk add --no-cache git
RUN git clone --filter=blob:none "https://github.com/${UPSTREAM_REPO}.git" /src \
 && cd /src \
 && git checkout --detach "${UPSTREAM_SHA}" \
 && test "$(git rev-parse HEAD)" = "${UPSTREAM_SHA}" \
 && (git describe --tags --always > /UPSTREAM_DESCRIBE) \
 && rm -rf .git

############################
# 2. Build (JDK 25 + Maven wrapper)
############################
FROM eclipse-temurin:25-jdk AS build
# Workaround: the upstream Maven wrapper script (mvnw 3.2.0) needs curl or wget to download
# Maven, and the eclipse-temurin images ship neither (the Java fallback needs
# MavenWrapperDownloader.java, which upstream does not commit).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY --from=src /src /src
COPY --from=src /UPSTREAM_DESCRIBE /UPSTREAM_DESCRIBE
# Generate ./calculadora/db/calculadora-pro.db (upstream README, step 3).
RUN --mount=type=cache,target=/root/.m2,sharing=locked \
    chmod +x mvnw \
 && mkdir -p ./calculadora/db \
 && ./mvnw flyway:migrate -Dflyway.configFiles=./flyway/flyway-pro.conf --batch-mode --errors --no-transfer-progress \
 && ls -lah ./calculadora/db/calculadora-pro.db
# Package the boot jar (upstream README, step 6) without running the upstream test suite.
RUN --mount=type=cache,target=/root/.m2,sharing=locked \
    ./mvnw clean package -DskipTests -Djacoco.skip=true --batch-mode --errors --no-transfer-progress \
 && ls -lah target/api-regime-geral.jar

############################
# 3. Runtime (JRE 25)
############################
FROM eclipse-temurin:25-jre AS runtime
ARG UPSTREAM_REPO
ARG UPSTREAM_SHA
ARG UPSTREAM_VERSION
LABEL org.opencontainers.image.title="mcp-reforma engine-regular" \
      org.opencontainers.image.description="Calculadora RTC (regime regular) built from the official ReceitaFederal repository at a pinned commit, unmodified" \
      org.opencontainers.image.source="https://github.com/${UPSTREAM_REPO}" \
      org.opencontainers.image.revision="${UPSTREAM_SHA}" \
      org.opencontainers.image.version="${UPSTREAM_VERSION}" \
      org.opencontainers.image.licenses="MIT" \
      br.mcpreforma.upstream.repo="${UPSTREAM_REPO}" \
      br.mcpreforma.upstream.sha="${UPSTREAM_SHA}"

# curl is only used by HEALTHCHECK (the JRE image ships no HTTP client).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app

# The app must run from this directory: application-offline.yml opens
# ./calculadora/db/calculadora-pro.db relative to the working directory.
WORKDIR /app
COPY --from=build --chown=root:root /src/target/api-regime-geral.jar /app/app.jar
COPY --from=build --chown=root:root /src/calculadora/db/calculadora-pro.db /app/calculadora/db/calculadora-pro.db
COPY --from=build --chown=root:root /UPSTREAM_DESCRIBE /app/UPSTREAM_DESCRIBE
RUN printf '%s\n' "${UPSTREAM_SHA}" > /app/UPSTREAM_SHA && chmod -R a+rX /app

ENV SPRING_PROFILES_ACTIVE=offline \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75" \
    TZ=America/Sao_Paulo

USER 10001:10001
# 8080 = API (context path /api); 9101 = actuator (/health, /metrics)
EXPOSE 8080 9101

# Spring Boot actuator health on the management port (management.server.port=9101,
# base-path "/"), see application-offline.yml.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:9101/health || exit 1

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
