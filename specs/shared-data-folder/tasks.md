# Shared data folder — tasks

## 1 · Processes, locks and the database

- [x] 1.1 (Unit) Replace the data folder's lock with named locks naming a process by pid and start time, taken over when that process is gone — R1.4, R2.1
- [x] 1.2 (Unit) Record each process with a heartbeat, and the process that opened each task — R2.1
- [x] 1.3 (Unit) Set the busy timeout, migrate once under a write lock, and refuse a newer schema naming the app that migrated it — R3.1, R3.2, R3.3
- [x] 1.4 (Unit) Interrupt only the tasks of gone processes, and sweep only their containers and the sandboxes of projects no live app holds — R2.2, R2.3

## 2 · Projects and once-per-machine work

- [x] 2.1 (Unit) Hold a project's lock while a task of it is open, refuse another app's task naming the holder, and list a held project as taken — R1.1, R1.2, R1.3
- [x] 2.2 (Unit) Run the first-start upgrade in one write transaction, the image build and the sign-in once across apps, and keep the desktop app's single instance — R4.1, R4.2, R4.3, R4.4

## 3 · Keys and changes

- [x] 3.1 (Unit) Keep the keys in one keychain store both apps read, and move each app's former keys into it — R5.1, R5.2
- [x] 3.2 (Unit) Push what another process changed within a second, from the database's data version and the lock files — R5.3, R1.3
