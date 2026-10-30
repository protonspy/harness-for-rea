---
autonomy: auto
ci: wait
branch: feat/sandbox-image-pull
delivery: in-review
pr: 3
---

# Sandbox images — requirements

## Purpose

Let the app get its sandbox image by itself: a base image built and published by the
repository's CI, pulled by the app and finished locally with the verified Claude Code
CLI, prepared at start without the user asking, and never taken as ready when it is
out of date. With it the egress proxy goes, and both sandboxes reach the internet
freely, isolated only by the files they are given
(adr:0012-pull-the-specialists-base-image-from-ghcr,
adr:0013-give-the-sandboxes-full-internet-access).

## R1 · The published base

- **R1.1** The sandbox shall build its base image — Node, the analysis tools, the non-root agent user and the ask-user MCP server, with no Claude Code binary — in the repository's CI and publish it to the GitHub Container Registry, tagged by the hash of its build context.
- **R1.2** When the base image's build context changes on a pushed branch, the publishing workflow shall publish it unless an image tagged with that hash already exists.
- **R1.3** The sandbox shall pin the base image by its registry digest together with the hash of the build context it was published from.
- **R1.4** If the base image's build context no longer matches the hash its pin records, then the test suite shall fail.

## R2 · The local specialist image

- **R2.1** The sandbox shall build the specialist image locally from the pinned base, adding only the Claude Code CLI of the pinned version, verified against its signed release manifest.
- **R2.2** The sandbox shall label the specialist image with the Claude Code version and the base image's pinned reference, and treat the image as ready only when both labels match the app's pins.

## R3 · Preparing the images

- **R3.1** When the app starts while Docker is running and the specialist image is not ready, the sandbox shall pull the base image and build the specialist image without the user asking, and report its progress where Settings shows the images.
- **R3.2** If Docker was not running when the app started, then the sandbox shall prepare the images the first time it finds Docker running.
- **R3.3** If preparing the images fails, then the sandbox shall report the failure and prepare them again only when the user asks from Settings.

## R4 · The network

- **R4.1** The sandbox shall run the specialist's container and the task container on Docker's default network with full internet access, through no proxy.
- **R4.2** When the app starts, the sandbox shall remove the egress proxy container, its image and the internal network an earlier version created, if they exist.

## Out of scope

- Restricting either sandbox's internet access.
- Signing the published image beyond its registry digest.
- Images for any platform but linux/amd64.
