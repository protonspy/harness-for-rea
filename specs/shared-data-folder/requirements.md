---
autonomy: auto
ci: wait
branch: feat/tui-revamp
delivery: merged
pr: 17
---

# Shared data folder — requirements

## Purpose

Several processes of Harness for REA — any number of terminal UIs and the desktop app — running
at the same time on one data folder, under adr:0024-share-the-data-folder-between-processes: each
app starts and runs tasks in projects no other app is running a task in, never disturbs another
app's live tasks or containers, and sees what the others change.

## R1 · Projects held by one app at a time

- **R1.1** When a task of a project starts or reopens in an app, the app shall take the project's lock and hold it while any task of that project is open in the app.
- **R1.2** If another live app holds the project's lock, then the app shall refuse to start or reopen the task, naming the project and the app that holds it.
- **R1.3** The app shall list every project and show a project whose lock another live app holds as taken by that app.
- **R1.4** If the process that holds a project's lock is gone, then the app shall take the lock over.

## R2 · Processes and recovery

- **R2.1** The app shall identify each process by its pid and its start time, and record which process opened each task.
- **R2.2** When an app starts, the app shall interrupt only the tasks left running, waiting or stopped whose process is gone.
- **R2.3** When an app starts, the app shall stop only the running task containers whose task's process is gone, and only the running sandboxes whose project no live app holds, leaving alone every container of a task or sandbox its database does not record.

## R3 · The database

- **R3.1** The app shall wait up to five seconds for a database another process is writing before failing.
- **R3.2** When several apps start together on one data folder, the database shall be migrated once.
- **R3.3** If the database was migrated by a newer app than this one, then the app shall refuse to open it before writing anything, naming the app and the version that migrated it.

## R4 · Done once per machine

- **R4.1** When several apps start together on a data folder holding tasks from before projects, the apps shall create one project per source folder.
- **R4.2** While another live app prepares the sandbox images, the app shall show the preparation as running in that app and shall not prepare them a second time.
- **R4.3** If another live app is signing Claude in, then the app shall refuse to start a second sign-in, naming that app.
- **R4.4** The desktop app shall keep a single instance per user profile.

## R5 · Keys and changes

- **R5.1** The apps shall keep provider keys in one OS-keychain store both read, so a key saved in either app is used by the other without being entered again.
- **R5.2** When an app first starts after an upgrade, the app shall move the keys it kept in its former store into the shared store and remove them from the former store.
- **R5.3** When another process changes a task, its steps, events or patches, or a project, the app shall show the change within one second.

## Out of scope

- Two apps running tasks of the same project at once.
- A live app taking over the tasks of an app that died while it runs: they are recovered at the next start of any app.
