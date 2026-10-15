# 2026-10-15: restore.sh restored an empty database (safety backup overwrote the dump)

**Status:** resolved before merge · **Where:** self-hosting kit, caught by the CI lab
(`.github/workflows/selfhost.yml`) · **Impact:** none in production (the kit was not released),
but on a real server this bug would have destroyed the backup being restored and replaced the
data with the broken state the operator was trying to recover from.

## Summary

The backup/restore check of run
[38807881576](https://github.com/trichains/webhook-relay/actions/runs/38807881576) backed up
259 events, wiped the database, ran `restore.sh` and got **0** rows back. `restore.sh` reported
success. The safety backup that `restore.sh` takes before restoring was written in the same second
as the dump being restored, got the same file name, and replaced it. The restore then faithfully
restored the empty database.

## Timeline (UTC)

| time | event |
|---|---|
| 21:13:32 | rows before: 1 source, 2 destinations, 259 events, 516 deliveries, 516 attempts |
| 21:13:32 | `backup.sh` → `relay-20261015T211332Z.dump` (92K) |
| 21:13:32 | lab wipes the data: `0 0 0 0 0` |
| 21:13:32 | `restore.sh --yes relay-20261015T211332Z.dump` takes its safety backup → `relay-20261015T211332Z.dump` (**16K**, same name) |
| 21:13:43 | `restore.done relay-20261015T211332Z.dump` (checksum OK: the `.sha256` was rewritten too) |
| 21:13:43 | rows after restore: `0 0 0 0 0` → check fails |

The two sizes on the same file name in the log (92K, then 16K) were the giveaway.

## Root cause

Two defects that only together lose data:

1. **Backup names had one-second resolution** (`relay-YYYYMMDDTHHMMSSZ.dump`) and the final
   `mv` replaced any existing file. Two backups within a second collided silently.
2. **`restore.sh` read the dump by name after taking the safety backup.** Anything that touched
   that name in between (a collision, or retention pruning it when `BACKUP_KEEP` is small) changed
   what was restored. The checksum check did not help because the colliding backup rewrote the
   `.sha256` as well.

A human is unlikely to run two backups in the same second, but the safety backup is automatic and
runs right after the operator picks a file, which is exactly when a fresh manual backup is most
likely to exist.

## Fix

- `deploy/ops/backup.sh`: millisecond timestamps (`relay-20261015T211332.123Z.dump`) and an
  explicit refusal to replace an existing dump (`backup.name_collision`).
- `deploy/scripts/restore.sh`: before the safety backup it pins a private copy
  (`.restore-<pid>-<name>`, a dotfile, so neither retention nor new backups can touch it) and reads
  the expected sha256 from the original `.sha256`. `deploy/ops/restore.sh` verifies the pinned
  copy against that value and restores the pinned copy. The pin is removed on exit.
- The CI check now also asserts that the dump file is byte-identical after the restore.

## What prevents a repeat

- The scenario that failed (backup, then restore within the same second, safety backup on) runs on
  every PR.
- Restores verify content against a checksum captured before anything else runs.
- The header of `restore.sh` explains why the pin exists and links here, so nobody "simplifies"
  it away.

## Lesson

"The restore succeeded" only means the tool ran. The lab compared row counts before and after,
which is what caught it; a restore drill that does not check the data would have passed.
