# 2026-10-15: self-hosting lab reported "-3 errors" during a deploy

**Status:** resolved · **Where:** CI lab (`.github/workflows/selfhost.yml`), not a user-facing
system · **Impact:** one red CI run; no false "green" was shipped, but the bug could have hidden
real errors in the zero-downtime numbers.

## Summary

The automatic-rollback step of the self-hosting lab failed although the rollback itself worked:
the load generator reported `health_total=465 health_ok=468 health_errors=-3`. More successful
responses than requests is impossible, so the measurement, not the system, was wrong. Root cause:
the function that stops the load workers ran in a command substitution subshell, where `wait`
cannot wait for the workers, so the logs were counted while the workers were still writing.

## Timeline (UTC)

| time | event |
|---|---|
| 21:06 | PR #1 pushed with the lab; run [38807312544](https://github.com/trichains/webhook-relay/actions/runs/38807312544) starts |
| 21:09:16 | zero-downtime step passes: `health_total=2709 health_ok=2709 ... ingest_total=198 ingest_ok=198` |
| 21:09:21 | rollback step: `deploy.sh` starts the crashing image on `app_blue` |
| 21:09:22 | `deploy.sh`: `ROLLBACK: app_blue restarted 3 time(s) during startup. green is still live (webhook-relay:v2)` (correct behavior) |
| 21:09:24 | load report `health_errors=-3`, step fails with "requests failed during the failed deploy" |

## Investigation

1. The deploy logs showed the expected sequence: crash detected after 1 s, container removed,
   live color untouched, `live v2 -> v2`. The system under test behaved.
2. A negative error count means `health_ok > health_total`. Both came from the same files, read
   by two separate pipelines (`cat … | wc -l`, then `cat … | awk …`), a few milliseconds apart.
   If the files grow between the two reads, the second read sees more lines.
3. Files can only grow after `load_stop` if the workers are still alive. `load_stop` does
   `touch stop` and then `wait $pid` for each worker. The callers run it as
   `result=$(load_stop "$dir")`. Command substitution runs in a subshell, and the workers are
   children of the parent shell, not of that subshell: `wait` returns immediately ("pid is not a
   child of this shell", silenced by `2>/dev/null || true`).
4. So the counts were taken while every worker could still append its last line. The
   zero-downtime step had the same race; it passed only because both of its reads happened to see
   the same number of lines.

## Root cause

`wait` used from a subshell for processes started by its parent. The error was suppressed, so the
"wait" was a no-op and nothing signaled it.

## Fix

`load_stop` (`deploy/ci/common.sh`) now polls each worker pid with `kill -0` until it exits (which
works from any process of the same user), then snapshots all worker logs into one file and
computes every number from that single snapshot.

## What prevents a repeat

- The counters come from one immutable file, so `ok > total` can no longer happen even if a
  worker were still running.
- The comment at the fix explains why `wait` is not used there.
- The step still asserts both `errors == 0` and a minimum number of requests, so a load
  generator that silently stops working fails the job instead of passing it.

## Lesson

Silencing an error (`2>/dev/null || true`) on a synchronization primitive turns a loud failure
into wrong data. In a test harness, wrong data is worse than a crash: it can report a deploy as
zero-downtime when it was not.
