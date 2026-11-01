---
autonomy: auto
ci: wait
branch: feat/finish-the-harness
delivery: in-review
pr: 13
---

# Release — requirements

## Purpose

Ships Harness for REA to users other than its developer: the desktop app and the CLI/TUI built for
Windows x64, macOS arm64 and macOS x64 by a release a maintainer starts by hand, published to GitHub
Releases, with the CLI also on npm. Nothing is signed or notarized, so macOS needs a documented
first-run step.

## R1 · Build

- **R1.1** The release workflow shall run only when a maintainer dispatches it by hand on `main`.
- **R1.2** The release workflow shall build the desktop app as an unsigned Windows x64 installer and unsigned macOS arm64 and x64 disk images.
- **R1.3** The release workflow shall build the CLI/TUI as a standalone binary for Windows x64, macOS arm64 and macOS x64, each archived with the sandbox sources it prepares the specialist's image from.
- **R1.4** If a CLI binary built for its runner's platform does not print its version, then the release workflow shall fail before publishing anything.

## R2 · Publish

- **R2.1** If the package's version is already a tag or already on npm, then the release workflow shall fail before building.
- **R2.2** When every build succeeded, the release workflow shall publish the desktop app and the CLI archives to a GitHub Release tagged with the package's version.
- **R2.3** When the GitHub Release is published, the release workflow shall publish the CLI package to npmjs with the token kept as the repository secret `NPM_TOKEN`.
- **R2.4** When the CLI package is installed with `npm install -g`, the CLI package shall give a command that starts the TUI on the Bun the package depends on, with the sandbox sources it carries.

## Out of scope

- Signing, notarizing and auto-update.
- Linux builds.
