---
autonomy: auto
ci: wait
branch: feat/river-auth-investigation
delivery: in-review
pr: 35
---

# River authentication investigation — requirements

## Purpose

Investigate official browser login support for connecting River AI accounts without manually pasting
an API key during onboarding, and record the architectural decision and external blocker (Issue #1).

## R1 · Technical investigation and capability detection

- **R1.1** The investigation shall verify whether River AI publishes an official external client authorization flow (OAuth 2.0, Device Authorization Grant, or equivalent).
- **R1.2** Where no official flow exists, the system shall record the external blocker and maintain API key entry as the explicitly supported authentication path.
- **R1.3** The system shall never capture passwords, cookies, or browser console sessions, nor copy credentials from other applications or synthesize undocumented endpoints.
- **R1.4** The browser sign-in interface for River shall explicitly report that browser login is not supported by River's API, directing the user to generate an API key in the official River Console.

## R2 · API key lifecycle and protection

- **R2.1** When a River API key is configured, it shall be stored exclusively in the host's protected OS keychain (DPAPI/safeStorage) via the main process key store.
- **R2.2** River API keys and credentials shall be redacted from application logs, timeline events, and error messages.
- **R2.3** Simulated key validation shall distinguish between invalid key (HTTP 401), access forbidden (HTTP 403), rate limit (HTTP 429), and upstream unreachable without exposing credential material.

## Out of scope

- Reverse-engineering private River Console endpoints or scraping session tokens.
- Native River chat completions provider integration (covered separately in Issue #3).
