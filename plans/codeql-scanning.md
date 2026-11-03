---
autonomy: auto
ci: wait
---

# Codeql scanning

A CodeQL workflow analyzes the TypeScript sources and the repository's own workflows on every
pull request, on `main` and weekly, and reports the alerts in the repository's code scanning.

## Why

Nothing in CI looked for security defects: the `gate` job builds, lints and tests, and no
check traced untrusted input through the code or the workflows. The repository is public, so
CodeQL code scanning costs nothing. Done when the analysis runs on a pull request and its
results reach code scanning.

## Paths

- `.github/workflows/codeql.yml` — the `analyze` job
- `docs/stack.md` — the CodeQL entry under Development

## References

- `plans/ci-pr-gate.md` — the `gate` job this runs beside, with the same least-privilege token

## Out of scope

- Requiring the code scanning check before a merge, which is a ruleset change on GitHub
- Custom queries or model packs

## Tasks

- [x] 1.1 (Unit) Add `.github/workflows/codeql.yml` analyzing `javascript-typescript` and `actions` with `security-extended`, on pull requests, pushes to `main` and a weekly schedule
- [x] 1.2 (Unit) Record CodeQL in `docs/stack.md`
  _Depends 1.1_

## Done when

- The pull request adding the workflow shows a passing `analyze` check for both languages
- The repository's code scanning lists a CodeQL analysis for each language
