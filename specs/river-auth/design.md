# River authentication investigation — design

## What changes

Serves Issue #1 and requirements R1.1–R2.3. Decided in
adr:0029-require-api-key-for-river-pending-official-external-authorization.

- `docs/adr/0029-require-api-key-for-river-pending-official-external-authorization.md` records the decision
  and external limitation.
- `src/main/river.ts` implements the River authentication investigation module:
  - Constants for River API origin (`https://api.river.ai`), console origin (`https://console.river.ai`),
    and documentation URLs.
  - `RiverAuthService`: implements capability check (`hasOfficialBrowserLoginFlow() === false`),
    formal rejection of browser login attempts with clear user-facing explanation, and simulated key
    validation lifecycle verifying HTTP status handling (401, 403, 429) without secret leakage.
- `tests/river.test.ts` tests:
  - River auth capability check and browser sign-in rejection.
  - Sanitization of errors and secrets.
  - Simulated key validation lifecycle.
