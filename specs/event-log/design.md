# Event log — design

## What changes

Serves R1.1, R1.2, R1.3, R2.1, R2.2, R2.3, R2.4, R3.1.

`src/main/events/` holds the store, applying
adr:0005-store-events-in-sqlite-with-raw-jsonl-per-task. Every writer — the
orchestrator, the specialist executor, the sandbox — calls one `EventLog.append`,
which redacts, caps, inserts, and hands the stored row to the push channel of
`specs/app-shell/`. Raw agent output goes through `EventLog.raw`, which redacts and
appends to `<userData>/tasks/<task>/raw.jsonl`.

## Data

```
tasks   id, request, source_root, model, state, result, created_at, updated_at,
        tokens_in, tokens_out, cost_usd, specialist_cost_usd
steps   id, task_id, ord, kind (todo|delegation), title, agent, state, data, created_at, updated_at
events  id (autoincrement), task_id, step_id, agent, at, kind, state, summary, payload, truncated
```

`state` is one of `pending`, `running`, `waiting`, `done`, `failed`, `cancelled`,
`interrupted`. Task totals are kept on the task row by the writer that records usage,
so history reads one row instead of summing events.

Redaction is pattern-based (`sk-or-…`, `sk-ant-…`, `Bearer …`, `-----BEGIN … PRIVATE
KEY-----`, OAuth access and refresh token fields) plus an exact match on secrets
registered at runtime, which is how the stored OpenRouter key is covered.
