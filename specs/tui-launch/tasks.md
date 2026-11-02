# TUI launch — tasks

## 1 · The folder

- [x] 1.1 (Unit) Parse the arguments, refuse a path that does not exist before the core starts, and answer help and version — R1.1, R1.7, R2.5
- [x] 1.2 (TDD) Classify a folder as too broad to mount or as the data folder, and match projects to it across path spellings — R1.5, R1.6, R1.2, R1.3
- [x] 1.3 (Unit) Open the folder's project, pick among several, or offer the prefilled creation, with the typed confirmation and the refusal — R1.2, R1.3, R1.4, R1.5, R1.6
  _Depends 1.2_

## 2 · Setup and resuming

- [x] 2.1 (Unit) Run the setup first when it is not completed, then the folder; open the last task with the continue flag, pick one with the resume flag, and list every project with `/projects` — R2.1, R2.2, R2.3, R2.4
  _Depends 1.3_
