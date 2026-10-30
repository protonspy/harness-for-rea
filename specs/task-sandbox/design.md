# Task sandbox — design

## What changes

Serves R1.1, R1.2, R1.3, R1.4, R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R3.1, R3.2, R3.3, R3.4, R4.1, R4.2, R4.3, R4.4.

A new `src/main/sandbox/` module owns the workspace, the container and the patch.
The specialist executor (`specs/claude-specialist/`) asks it for a prepared run and
reads the CLI's stream-json from the container's stdout exactly as it would from a
host process. Decided in adr:0006-run-the-specialist-inside-a-container-per-task,
which supersedes adr:0004-sandbox-delegated-work-in-a-read-only-copy.

## Boundaries and contracts

Host layout, under the app's data folder:

```
workspace/<uuid>/        copies, mounted at /work
runs/<uuid>/             system.md, mounted read-only at /run/hfr
snapshots/<uuid>/        pristine copy and manifest.json {path: sha256}, never mounted
```

The run, one container per delegation:

```
docker run --rm -i --name hfr-<uuid> --hostname sandbox
  --user agent --cap-drop ALL --security-opt no-new-privileges
  --read-only --tmpfs /tmp --tmpfs /home/agent
  --memory <m> --cpus <c> --pids-limit <p>
  -v <userData>/workspace/<uuid>:/work[:ro]
  -v <userData>/runs/<uuid>:/run/hfr:ro
  -v hfr-claude-config:/home/agent/.claude-config
  -e CLAUDE_CONFIG_DIR=/home/agent/.claude-config
  -e DISABLE_AUTOUPDATER=1 -e DISABLE_TELEMETRY=1
  -w /work hfr-specialist:<pinned-version>
  claude -p --setting-sources "" --strict-mcp-config
         --input-format stream-json --output-format stream-json --verbose
         --model opus --tools Read,Grep,Glob[,Edit,Write]
         --system-prompt-file /run/hfr/system.md
```

`runs/<uuid>/` holds the rendered system prompt, outside `/work` so it never shows
up in the specialist's view of the files or in a patch.

The container is on Docker's default network with full internet access
(adr:0013-give-the-sandboxes-full-internet-access). The specialist image is built
locally from the pinned base image of specs/sandbox-images, adding the CLI from
`sandbox/specialist/Dockerfile`, which pins its version and checks the Linux binary's
SHA-256 against the gpg-verified release manifest. Login
uses the same image with `claude auth login --claudeai` and the same config volume.

The prompt is rendered from a typed context package. Its `brief` is free text the
orchestrator writes (adr:0007-run-the-orchestrators-tools-in-a-task-container), so R3.2
holds by scrubbing: every string field has the source folder's host path, in either
separator and any case, and the orchestrator's `/workspace` prefix replaced with
`/work`. Paths in the package are relative to the source root and become
`/work/<path>` in the container.

## Alternatives considered

Diffing against the
manifest alone was rejected for R4.1 because a patch needs the base content, hence
the snapshot.

## Risks

- Docker Desktop must be running; it was not when this was designed.
- Copying through Docker Desktop's file sharing makes large workspaces slow; the
  context package's file list is the lever, not a cache.
- The config volume holds the login token, readable by every specialist run, and with
  full internet access nothing stops a steered specialist from sending it out.
