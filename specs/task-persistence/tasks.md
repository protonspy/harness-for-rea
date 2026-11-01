# Task persistence — tasks

## 1 · Conversation

- [x] 1.1 (Unit) Store checkpoints and writes in SQLite under a MemorySaver subclass, and load a thread back — R1.1, R1.2

## 2 · Files and containers

- [x] 2.1 (Unit) Keep the task container across a stop, bind its scratch from the task's folder, and start or recreate it on reopen — R3.2, R3.4, R3.5
- [x] 2.2 (Unit) Record sandboxes, bind the specialist's output, stop them at the task's end and bring them up again on a reopen — R3.3, R3.4, R3.5, R3.6
- [x] 2.3 (Unit) Put every delegation's folders under the task's folder and never discard them, and take discard out of Settings — R3.1, R3.7, R4.3

## 3 · Reopening and deleting

- [x] 3.1 (Unit) Reopen a task with no live run on Continue or on a message, and leave conversations open after a restart — R1.2, R2.1, R2.2, R2.3
- [x] 3.2 (Unit) Delete a task with its containers, folder, patches, conversation and records, refused while a turn runs — R4.1, R4.2, R4.3
- [x] 3.3 (Unit) Offer Continue and Delete in the task view and keep the composer open on a closed task — R2.1, R2.2, R4.1
