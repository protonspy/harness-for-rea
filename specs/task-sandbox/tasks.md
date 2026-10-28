# Task sandbox — tasks

## 1 · Workspace

- [x] 1.1 (TDD) Resolve each requested path against the source root and reject `..`, absolute paths, symbolic links and junctions — R1.3
- [x] 1.2 (Unit) Create `workspace/<uuid>/`, `runs/<uuid>/` and `snapshots/<uuid>/`, copy the named files with their relative paths, and write the SHA-256 manifest — R1.1, R1.2
  _Depends 1.1_
- [x] 1.3 (Unit) Delete the workspace, run directory and snapshot on completion when discard is enabled — R1.4
  _Depends 1.2_

## 2 · Container

- [x] 2.1 (Unit) Write `sandbox/Dockerfile` for the specialist image, pinning the Claude Code version and checking the Linux binary against the gpg-verified release manifest — R2.6
- [x] 2.2 (Unit) Write the egress proxy image and the internal `hfr-sandbox` network, allowing only Claude Code's required domains — R2.4
- [x] 2.3 (Unit) Build the `docker run` argument list from a prepared run: mounts, read-only in read mode, non-root user, dropped capabilities, read-only root, limits, network and allowlisted environment — R2.1, R2.2, R2.3, R3.2, R3.3
  _Depends 1.2_
- [x] 2.4 (Unit) Check Docker and the image before a delegation and refuse with the reason when either is missing — R2.6
  _Depends 2.1_
- [x] 2.5 (Unit) Kill the container on cancel or timeout and record the outcome — R2.5
  _Depends 2.3_

## 3 · Context isolation

- [x] 3.1 (Unit) Render the specialist's prompt and system prompt from the typed context package only, mapping paths to `/work/<path>` and stating that the artifacts are owned or authorized — R3.1, R3.2, R3.4
- [x] 3.2 (Unit) Assert that a rendered run carries no host path, host environment variable, orchestrator message or other task's data — R3.2
  _Depends 2.3, 3.1_
- [x] 3.3 (Unit) Start Claude Code restricted to `/work`, with permission prompts denied and file tools denied under the home directory — R3.5
  _Depends 2.3_
- [x] 3.4 (Unit) Render the orchestrator's brief first in the prompt and scrub host and `/workspace` paths from every text field of the package — R3.1, R3.2
  _Depends 3.1_

## 4 · Changes and audit

- [x] 4.1 (Unit) Produce a patch from the workspace against its snapshot when a modify-mode step completes — R4.1
  _Depends 1.2_
- [x] 4.2 (TDD) Apply an approved patch to the originals, refusing it when an original's SHA-256 differs from the manifest — R4.2, R4.3
  _Depends 4.1_
- [x] 4.3 (Unit) Emit events for files copied, files read or written by the specialist, and each patch decision — R4.4
  _Depends 1.2, 4.2_
- [x] 4.4 (Unit) Leave links, special names, `.git` paths and text files turned binary out of the patch, escape control and bidi characters in the diff, and cap patch and diff sizes — R4.5
  _Depends 4.1_
