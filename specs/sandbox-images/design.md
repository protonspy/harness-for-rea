# Sandbox images — design

## What changes

Serves R1–R4, under adr:0012-pull-the-specialists-base-image-from-ghcr and
adr:0013-give-the-sandboxes-full-internet-access.

- **Two build contexts.** `sandbox/specialist-base/` holds what `sandbox/specialist/`
  holds today minus Claude Code: the pinned Node base, ripgrep, the `agent` user, the
  mount points and `ask-user.mjs`. `sandbox/specialist/Dockerfile` keeps its verify
  stage and becomes `FROM ${BASE}` plus the verified binary and the labels
  `hfr.claude-code` and `hfr.base` (R2.1, R2.2). `sandbox/egress/` is deleted.
- **Context hash.** `scripts/context-hash.mjs` hashes a build context: its files
  sorted by path, each as path, NUL, content with CRLF folded to LF, NUL, so a Windows
  checkout and the Linux runner agree. CI, the pin script and the test share it.
- **Publishing (R1.1, R1.2).** `.github/workflows/images.yml` runs on a push touching
  the base context or the workflow, on any branch: it computes the hash, skips when
  `ghcr.io/<owner>/hfr-specialist-base:<hash>` exists, otherwise builds for
  linux/amd64 with no provenance or SBOM attestations, labels
  `org.opencontainers.image.source`, and pushes. It runs with `packages: write` and
  nothing more.
- **The pin (R1.3, R1.4).** `sandbox/images.json` is
  `{ "specialistBase": { "ref": "ghcr.io/…@sha256:…", "context": "<hash>" } }`.
  `scripts/pin-images.mjs` resolves the tag of the current hash to its digest with
  `docker buildx imagetools inspect` and rewrites the file. A test recomputes the hash
  and fails on a mismatch, which is how a context change that was never republished
  and re-pinned stops at CI.
- **Readiness (R2.2).** `dockerState` reads both labels in one `image inspect` and
  compares them to `CLAUDE_CODE_VERSION` and the pinned ref. The egress image check
  goes.
- **Preparing (R3).** `prepareImages` replaces `buildImages`: `docker pull <ref>`, then
  `docker build` of the local layer with `--build-arg BASE=<ref>`. `SandboxService`
  gains an automatic preparation: the first `status()` that finds Docker running and
  the image not ready starts it once per app session; a failure stays reported until
  the user prepares again from Settings. `index.ts` calls `status()` at start.
- **Network (R4).** `confined()` loses `--network hfr-sandbox` and the proxy
  variables; the task container loses `--network none`. `ensureNetwork` becomes
  `removeLegacyNetwork`, run once at start: `rm -f hfr-egress`, then
  `network rm hfr-sandbox`, each ignoring "not found". `preflight` no longer starts
  anything.

## Risks

- A base context changed and pushed before CI publishes leaves the pin stale: the
  tests fail until `pin-images` runs against the published tag.
- A new GHCR package is private until its visibility is set to public once on GitHub;
  until then the anonymous pull fails with "denied".
