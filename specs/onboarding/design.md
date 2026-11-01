# Onboarding — design

## What changes

Serves R1.1–R2.2.

- `src/shared/types.ts`, `src/shared/defaults.ts`, `src/shared/api.ts` — `Settings.setupCompleted`
  (false by default) and a `readiness` IPC call returning each step's state and reason: sandbox
  (Docker, images, building), Claude Code (signed in, plan), model (provider, key set, model, models
  listed or the provider's error).
- `src/main/readiness.ts` (new) — computes the three steps from the existing sandbox service, login
  service, key store and `listModels`; the runner refuses to start a task while a step is not ready
  (R2.1).
- `src/renderer/src/views/Setup.tsx` (new) — a stepper of three cards built on shadcn/ui, each
  reusing what Settings already does: preparing the images, the sign-in flow, the provider, key, base
  URL and model choice. Finish is enabled only when all three are ready.
- `src/renderer/src/App.tsx` — opens on Setup until `setupCompleted`; afterwards a readiness banner
  names a step that stopped being ready (R2.1). Settings links back to the setup (R2.2).
- The pieces of `Settings.tsx` the setup reuses move into components shared by both views.
