# syntax=docker/dockerfile:1.7
#
# engine-simples — Calculadora RTC, Simples Nacional (ReceitaFederal/calculadora-rtc-simples-nacional)
#
# Builds the OFFICIAL upstream code at a pinned commit. No patches are applied to the
# upstream sources; any workaround lives in this file and is commented.
#
#   docker build --build-arg UPSTREAM_SHA=<simples sha> --build-arg UPSTREAM_REGULAR_SHA=<regular sha> \
#     -t mcp-reforma/engine-simples engines/simples
#
# Notes
# - The Simples engine has no database scripts of its own. As documented in its README
#   (step 3), the SQLite database is generated with the `flyway/` folder of the
#   regime-regular repository; we take it at UPSTREAM_REGULAR_SHA (the same commit used by
#   engine-regular), so both engines share the same base version.
# - Upstream tests are NOT run in the image build (-DskipTests, -Djacoco.skip=true) to keep
#   builds fast; our golden tests exercise the running image instead.

ARG UPSTREAM_REPO=ReceitaFederal/calculadora-rtc-simples-nacional
ARG UPSTREAM_SHA=a926d5a76095ac0295a6612a9a54db7ffead2396
ARG UPSTREAM_VERSION=1.0.2-1-ga926d5a
ARG UPSTREAM_REGULAR_REPO=ReceitaFederal/calculadora-rtc-regime-regular
ARG UPSTREAM_REGULAR_SHA=f1eebd7ce3157423b1a6aaca7dc1d6c3395452c4

############################
# 1. Fetch upstream sources
############################
FROM alpine:3.22 AS src
ARG UPSTREAM_REPO
ARG UPSTREAM_SHA
ARG UPSTREAM_REGULAR_REPO
ARG UPSTREAM_REGULAR_SHA
RUN apk add --no-cache git
RUN git clone --filter=blob:none "https://github.com/${UPSTREAM_REPO}.git" /src \
 && cd /src \
 && git checkout --detach "${UPSTREAM_SHA}" \
 && test "$(git rev-parse HEAD)" = "${UPSTREAM_SHA}" \
 && (git describe --tags --always > /UPSTREAM_DESCRIBE) \
 && rm -rf .git
RUN git clone --filter=blob:none "https://github.com/${UPSTREAM_REGULAR_REPO}.git" /regular \
 && cd /regular \
 && git checkout --detach "${UPSTREAM_REGULAR_SHA}" \
 && test "$(git rev-parse HEAD)" = "${UPSTREAM_REGULAR_SHA}" \
 && rm -rf .git

############################
# 2. Database (Flyway, from the regime-regular repository)
############################
FROM eclipse-temurin:25-jdk AS jdk
# Workaround: the upstream Maven wrapper script (mvnw 3.2.0) needs curl or wget to download
# Maven, and the eclipse-temurin images ship neither.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

FROM jdk AS db
# Workaround: the Simples README says "copy the regime-regular flyway/ folder into this
# project and run ./mvnw flyway:migrate". The Simples pom.xml, however, does not declare
# the flyway-maven-plugin (the regime-regular pom does), so the `flyway:` prefix is not
# guaranteed to resolve there. We therefore run the very same command inside the
# regime-regular checkout at UPSTREAM_REGULAR_SHA, which produces the same database file.
WORKDIR /regular
COPY --from=src /regular /regular
RUN --mount=type=cache,target=/root/.m2,sharing=locked \
    chmod +x mvnw \
 && mkdir -p ./calculadora/db \
 && ./mvnw flyway:migrate -Dflyway.configFiles=./flyway/flyway-pro.conf --batch-mode --errors --no-transfer-progress \
 && ls -lah ./calculadora/db/calculadora-pro.db

############################
# 3. Build the Simples engine (JDK 25 + Maven wrapper)
############################
FROM jdk AS build
WORKDIR /src
COPY --from=src /src /src
RUN --mount=type=cache,target=/root/.m2,sharing=locked \
    chmod +x mvnw \
 && ./mvnw clean package -DskipTests -Djacoco.skip=true --batch-mode --errors --no-transfer-progress \
 && ls -lah target/api-simples-nacional.jar

############################
# 4. Runtime (JRE 25)
############################
FROM eclipse-temurin:25-jre AS runtime
ARG UPSTREAM_REPO
ARG UPSTREAM_SHA
ARG UPSTREAM_VERSION
ARG UPSTREAM_REGULAR_REPO
ARG UPSTREAM_REGULAR_SHA
LABEL org.opencontainers.image.title="mcp-reforma engine-simples" \
      org.opencontainers.image.description="Calculadora RTC (Simples Nacional) built from the official ReceitaFederal repository at a pinned commit, unmodified; database from regime-regular flyway scripts" \
      org.opencontainers.image.source="https://github.com/${UPSTREAM_REPO}" \
      org.opencontainers.image.revision="${UPSTREAM_SHA}" \
      org.opencontainers.image.version="${UPSTREAM_VERSION}" \
      org.opencontainers.image.licenses="MIT" \
      br.mcpreforma.upstream.repo="${UPSTREAM_REPO}" \
      br.mcpreforma.upstream.sha="${UPSTREAM_SHA}" \
      br.mcpreforma.upstream.db.repo="${UPSTREAM_REGULAR_REPO}" \
      br.mcpreforma.upstream.db.sha="${UPSTREAM_REGULAR_SHA}"

# curl is only used by HEALTHCHECK (the JRE image ships no HTTP client).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app

# The app must run from this directory: application-offline.yml opens
# ./calculadora/db/calculadora-pro.db relative to the working directory.
WORKDIR /app
COPY --from=build --chown=root:root /src/target/api-simples-nacional.jar /app/app.jar
COPY --from=db --chown=root:root /regular/calculadora/db/calculadora-pro.db /app/calculadora/db/calculadora-pro.db
COPY --from=src --chown=root:root /UPSTREAM_DESCRIBE /app/UPSTREAM_DESCRIBE
RUN printf '%s\n' "${UPSTREAM_SHA}" > /app/UPSTREAM_SHA \
 && printf '%s\n' "${UPSTREAM_REGULAR_SHA}" > /app/UPSTREAM_DB_SHA \
 && chmod -R a+rX /app

# DB_DOWNLOAD_URL stays empty: the database is baked into the image, never downloaded.
ENV SPRING_PROFILES_ACTIVE=offline \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75" \
    TZ=America/Sao_Paulo

USER 10001:10001
# 8082 = API (context path /api); 9103 = actuator (/health, /metrics)
EXPOSE 8082 9103

# Spring Boot actuator health on the management port (management.server.port=9103,
# base-path "/"), see application-offline.yml.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:9103/health || exit 1

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
