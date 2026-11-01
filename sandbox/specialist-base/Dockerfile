# The specialist's base image: everything but Claude Code, built and published by CI to GHCR and
# pinned by digest in sandbox/images.json (adr:0012-pull-the-specialists-base-image-from-ghcr). The app
# adds the verified CLI on top in sandbox/specialist. Node runs the ask-user MCP server
# (adr:0008-ask-the-user-from-the-specialist-over-the-run-channel) and REA, the reverse engineering MCP
# server the specialist works through, with Ghidra, a JDK 21, JADX and Apktool for it
# (adr:0018-make-rea-native-to-the-specialist, specs/rea-native R1).

ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# Each engine comes from its own release, pinned by version and checked against its SHA-256 before use.
FROM ${NODE_IMAGE} AS fetch
ARG JDK_URL=https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz
ARG JDK_SHA256=d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip
ARG GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
ARG JADX_URL=https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar
ARG JADX_SHA256=6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75
ARG APKTOOL_URL=https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar
ARG APKTOOL_SHA256=dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /fetch
RUN curl -fsSL "$JDK_URL" -o jdk.tar.gz \
 && echo "$JDK_SHA256  jdk.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/jdk-21 && tar -xzf jdk.tar.gz -C /opt/jdk-21 --strip-components=1 \
 && curl -fsSL "$GHIDRA_URL" -o ghidra.zip \
 && echo "$GHIDRA_SHA256  ghidra.zip" | sha256sum -c - \
 && unzip -q ghidra.zip -d /tmp/ghidra && mv /tmp/ghidra/ghidra_* /opt/ghidra \
 && test -x /opt/ghidra/Ghidra/Features/Decompiler/os/linux_x86_64/decompile \
 && mkdir -p /opt/jadx /opt/apktool \
 && curl -fsSL "$JADX_URL" -o /opt/jadx/jadx-headless-mcp.jar \
 && echo "$JADX_SHA256  /opt/jadx/jadx-headless-mcp.jar" | sha256sum -c - \
 && curl -fsSL "$APKTOOL_URL" -o /opt/apktool/apktool.jar \
 && echo "$APKTOOL_SHA256  /opt/apktool/apktool.jar" | sha256sum -c - \
 && rm -rf /fetch/* /tmp/ghidra

FROM ${NODE_IMAGE}
ARG REA_VERSION=6.8.0
LABEL hfr.rea="$REA_VERSION"

# procps: REA checks a child's owner with `ps` before it supervises Ghidra, JADX or Apktool.
# The base's `node` user holds uid 1000, which the login container runs as `agent`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ripgrep procps file unzip \
 && rm -rf /var/lib/apt/lists/* \
 && userdel --remove node \
 && useradd --uid 1000 --create-home --shell /usr/sbin/nologin agent \
 && mkdir -p /home/agent/.claude-config /work /run/hfr /run/hfr-ask /opt/hfr \
 && chown agent:agent /home/agent/.claude-config

COPY --from=fetch /opt/jdk-21 /opt/jdk-21
COPY --from=fetch /opt/ghidra /opt/ghidra
COPY --from=fetch /opt/jadx /opt/jadx
COPY --from=fetch /opt/apktool /opt/apktool

# REA from the lockfile beside this file: every package at its locked version and integrity hash, no optional
# package (Frida's binding among them) and no install scripts; then its whole skill, references included,
# where the operating guide points the specialist.
COPY rea /opt/rea
RUN cd /opt/rea \
 && npm ci --omit=optional --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force \
 && test ! -e node_modules/frida \
 && ln -s /opt/rea/node_modules/.bin/rea /usr/local/bin/rea \
 && test "$(rea --version)" = "$REA_VERSION" \
 && cp -r /opt/rea/node_modules/rea-agents/skills/reverse-engineer-anything /opt/hfr/rea-skill \
 && test -f /opt/hfr/rea-skill/SKILL.md \
 && printf '#!/bin/sh\nexec /opt/jdk-21/bin/java -jar /opt/apktool/apktool.jar "$@"\n' > /usr/local/bin/apktool \
 && chmod 0755 /usr/local/bin/apktool

COPY ask-user.mjs /opt/hfr/ask-user.mjs
COPY AGENTS.md /opt/hfr/AGENTS.md

ENV JAVA_HOME=/opt/jdk-21 \
    GHIDRA_INSTALL_DIR=/opt/ghidra \
    REA_JADX_MCP_JAR=/opt/jadx/jadx-headless-mcp.jar \
    REA_APKTOOL_COMMAND=/usr/local/bin/apktool \
    PATH=/opt/jdk-21/bin:$PATH

USER agent
WORKDIR /work
