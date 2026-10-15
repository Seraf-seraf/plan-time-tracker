# Plan Time Tracker plugin

Authenticated MCP commands register plans, explicitly start/pause/resume/finish server-timed work intervals, manage fenced checkpoint attempts, and record checks tied to result revisions. The web UI uses the same command layer. No repository, synchronization, commit/push integration or external token is required.

Read [track-plan](skills/track-plan/SKILL.md) for lifecycle intent, lease/replay rules and honest evidence handling. This package points to the existing private Site App; local source preparation does not update its installed tools or live publication. Clients must refresh tool discovery after the reviewed release.

`node scripts/source-snapshot.mjs <source-directory> [--expect sha256:64hex]` captures a deterministic v2 source identity without external executables. See [the source contract](../../docs/worktree-evidence.md) for scope and exclusions. Keep generated evidence outside that directory. Send `sourceSnapshot` without local `fileCount`; checks use `testedSnapshotDigest` and the exact result revision.

`observation-queue.mjs` accepts one stdin JSON object and an operation (`enqueue`, `next`, `begin`, `acknowledge`, `fail`, `requeue-pending`, `list`). Supply authenticated `ownerScope` and `planContext` (assigned plan ID). It never authenticates, performs network calls or changes lifecycle. Queue files are local-only. Old repository-scoped queue files remain untouched and are not automatically replayed.

Run `node --test test/*.test.mjs`. Test fixtures contain only synthetic metadata and local temporary directories. No runtime credentials or authentication bypass are bundled.
