# Sandbox images — tasks

## 1 · The published base

- [x] 1.1 (Unit) Split the base build context out of `sandbox/specialist/` and add the context hash script — R1.1
- [x] 1.2 (Unit) Add the workflow that publishes the base image to GHCR by context hash — R1.1, R1.2
  _Depends 1.1_
- [ ] 1.3 (Unit) Add the pin file, the pin script and the test that holds the pin to the context — R1.3, R1.4
  _Depends 1.2_

## 2 · The local specialist image

- [ ] 2.1 (Unit) Build the specialist image from the pinned base with the verified CLI and both labels, and check readiness by them — R2.1, R2.2
  _Depends 1.3_

## 3 · Preparing the images

- [ ] 3.1 (Unit) Pull and build in place of the local build, and prepare automatically once per session when Docker is found running — R3.1, R3.2, R3.3
  _Depends 2.1_

## 4 · The network

- [ ] 4.1 (Unit) Remove the egress proxy, its network and the task container's `--network none`, and clean up what an earlier version left — R4.1, R4.2
