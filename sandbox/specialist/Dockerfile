# The specialist image: the pinned Claude Code CLI for Linux, verified at build time against the
# release manifest, whose gpg signature is checked against Anthropic's release key
# (adr:0006-run-the-specialist-inside-a-container-per-task, specs/task-sandbox R2.6), on a Node base
# that runs the ask-user MCP server (adr:0008-ask-the-user-from-the-specialist-over-the-run-channel).

FROM debian:bookworm-slim AS verify
ARG CLAUDE_CODE_VERSION
ARG REPOSITORY=https://downloads.claude.ai/claude-code-releases
ARG RELEASE_SIGNER_URL=https://downloads.claude.ai/keys/claude-code.asc
# The fingerprint published on Claude Code's setup page.
ARG FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
ARG PLATFORM=linux-x64

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg jq \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /verify
RUN test -n "$CLAUDE_CODE_VERSION" \
 && export GNUPGHOME="$(mktemp -d)" \
 && curl -fsSL "$RELEASE_SIGNER_URL" -o key.asc \
 && gpg --batch --import key.asc \
 && curl -fsSL "$REPOSITORY/$CLAUDE_CODE_VERSION/manifest.json" -o manifest.json \
 && curl -fsSL "$REPOSITORY/$CLAUDE_CODE_VERSION/manifest.json.sig" -o manifest.json.sig \
 && gpg --batch --status-fd 1 --verify manifest.json.sig manifest.json > status.txt \
 && grep -E "^\[GNUPG:\] VALIDSIG .* $FINGERPRINT$|^\[GNUPG:\] VALIDSIG $FINGERPRINT " status.txt \
 && test "$(jq -r .version manifest.json)" = "$CLAUDE_CODE_VERSION" \
 && checksum="$(jq -r --arg p "$PLATFORM" '.platforms[$p].checksum' manifest.json)" \
 && echo "$checksum" | grep -Eq '^[0-9a-f]{64}$' \
 && curl -fsSL "$REPOSITORY/$CLAUDE_CODE_VERSION/$PLATFORM/claude" -o claude \
 && echo "$checksum  claude" | sha256sum -c - \
 && chmod 0755 claude

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ARG CLAUDE_CODE_VERSION
LABEL hfr.claude-code="$CLAUDE_CODE_VERSION"

# The base's `node` user holds uid 1000, which every container the app starts runs as `agent`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && userdel --remove node \
 && useradd --uid 1000 --create-home --shell /usr/sbin/nologin agent \
 && mkdir -p /home/agent/.claude-config /work /run/hfr /run/hfr-ask /opt/hfr \
 && chown agent:agent /home/agent/.claude-config

COPY --from=verify /verify/claude /usr/local/bin/claude
COPY ask-user.mjs /opt/hfr/ask-user.mjs

USER agent
WORKDIR /work
