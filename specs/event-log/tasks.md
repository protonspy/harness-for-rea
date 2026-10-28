# Event log — tasks

## 1 · Schema and redaction

- [x] 1.1 (TDD) Redact secret patterns and registered secrets from strings and nested payloads — R1.2
- [x] 1.2 (Unit) Open the database with `user_version` migrations for tasks, steps and events, and the repository functions over them — R1.1, R2.1

## 2 · Writing and reading

- [x] 2.1 (Unit) Append an event: redact, cap the payload, insert, push; append raw lines to the task's JSONL — R1.3, R2.2, R2.3
  _Depends 1.1, 1.2_
- [x] 2.2 (Unit) Return a task's history, paged, and the task list — R2.4
  _Depends 1.2_
- [x] 2.3 (Unit) Mark tasks and steps left running or waiting as interrupted at startup — R3.1
  _Depends 2.1_
