# River authentication investigation — design

## What changes

Serves Issue #1 and requirements R1.1–R2.3. Decided in
adr:0029-require-api-key-for-river-pending-official-external-authorization.

- `docs/adr/0029-require-api-key-for-river-pending-official-external-authorization.md` records the architectural
  decision and external limitation.
- `src/main/river.ts` implements the River authentication investigation module:
  - Constants for River API origin (`https://api.river.ai`), base URL (`https://api.river.ai/v1`), models endpoint
    (`https://api.river.ai/v1/models`), console origin (`https://console.river.ai`), and documentation URLs.
  - `RiverAuthService`: implements capability check (`hasOfficialBrowserLoginFlow() === false`), formal rejection
    of browser login attempts with clear user-facing explanation pointing to the console keys URL, and safe key
    validation strictly against `RIVER_MODELS_URL`.
  - Secret containment: key formatting is sanitized before request dispatch, and all caught errors and response
    payloads are redacted using `src/main/events/redact.ts`.
  - Response parsing: validates JSON schema (`data` array of models), rejects HTML 200 responses, and distinguishes
    empty catalogs from malformed responses.
  - Note: `RiverAuthService` is currently an isolated service with simulated test coverage. Core wiring into
    dispatch, onboarding UI, and settings will occur during Issue #3 (native River provider).
- `tests/river.test.ts` tests:
  - River auth capability check and browser sign-in rejection.
  - Sanitization of errors, header newline protection, and transport exception secret redaction.
  - Strictly targets `RIVER_MODELS_URL` without accepting arbitrary URLs.
  - Verification of HTTP 200 responses (HTML rejection, malformed JSON, schema validation, empty vs populated catalog).
  - Status classification (401, 403, 429, network failure).
