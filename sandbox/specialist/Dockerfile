# The specialist image: the pinned base pulled from GHCR (adr:0012-pull-the-specialists-base-image-from-ghcr)
# plus the pinned Claude Code CLI for Linux, verified at build time against the release manifest,
# whose gpg signature is checked against Anthropic's release key
# (adr:0006-run-the-specialist-inside-a-container-per-task, specs/task-sandbox R2.6). Built locally,
# so the binary is never redistributed.

ARG BASE

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

FROM ${BASE}
ARG BASE
ARG CLAUDE_CODE_VERSION
LABEL hfr.claude-code="$CLAUDE_CODE_VERSION" hfr.base="$BASE"

COPY --from=verify /verify/claude /usr/local/bin/claude
