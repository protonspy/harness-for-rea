# The specialist's base image: everything but Claude Code, built and published by CI to GHCR and
# pinned by digest in sandbox/images.json (adr:0012-pull-the-specialists-base-image-from-ghcr). The app
# adds the verified CLI on top in sandbox/specialist. Node runs the ask-user MCP server
# (adr:0008-ask-the-user-from-the-specialist-over-the-run-channel).

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# The base's `node` user holds uid 1000, which every container the app starts runs as `agent`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && userdel --remove node \
 && useradd --uid 1000 --create-home --shell /usr/sbin/nologin agent \
 && mkdir -p /home/agent/.claude-config /work /run/hfr /run/hfr-ask /opt/hfr \
 && chown agent:agent /home/agent/.claude-config

COPY ask-user.mjs /opt/hfr/ask-user.mjs

USER agent
WORKDIR /work
