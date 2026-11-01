---
autonomy: auto
ci: wait
---

# Ci pr gate

CI runs on pull requests only, and `main` takes a change only through a pull request whose
build, format, lint and tests passed.

## Why

CI ran on every push to `main` and on pull requests, but nothing stopped a merge or a direct
push to `main` while it was red. The user asked that a change reach `main` only when its tests
pass.

## Paths

- `.github/workflows/ci.yml` — the `gate` job and its triggers
- GitHub branch protection of `main` — the required `gate` check

## References

- `.claude/rules/delivery.md` — every change lands through a pull request

## Out of scope

- Requiring a review approval before a merge
- Running `scc validate` in CI; the pre-push hook runs it locally
- The Images workflow, which publishes the base image on its own triggers

## Tasks

- [x] 1.1 (Unit) Run the CI gate on pull requests only, one run per pull request at a time
- [ ] 1.2 (Unit) Protect `main`: require the `gate` check, up to date with `main`, for administrators too
  _Depends 1.1_

## Done when

- A pull request into `main` shows the `gate` check, and GitHub refuses its merge while the check is red or pending
- A direct push to `main` is refused
