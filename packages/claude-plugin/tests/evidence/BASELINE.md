# TASK-301 BASELINE (post-TASK-205 checkout, NOT the pre-redesign baseline)

Every number below is PROVISIONAL. Environment: Node v22.14.0, Windows 11 (10.0.26200) x64, AMD Ryzen 7 7800X3D (16 threads), Git Bash. Mock clock: the harness defaults used by `scripts/blitrate.ts` (10 s window after 1 s settle, 140 columns).

## Scope decision
This worktree is HEAD 66712d4, after TASK-201..205 were integrated, so anything captured here is an "after" capture. The authoritative "before" set was produced by TASK-205 and was left untouched: `before/`, `before-60.txt`, `before-140.txt`, `before-bench.txt`, `blitrate.txt`, `baseline/`.

## Provenance (a, b)
- HEAD: 66712d423b3b6c0d06d6a99c157680f68a97fe3b, branch agent/ebf4b7b4/TASK-301-re-baseline-provenance-p
- `git status --short` at start: empty
- `git diff --stat` at start: empty
- `git diff -- . ':!packages/claude-plugin'`: empty. sha256 of empty input: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
- Untracked files outside the plugin: none. `test/roles.test.ts` does not exist (test/ holds core.test.ts, helpers.ts, milestone.test.ts).
- **Outside-plugin baseline for TASK-307 = empty diff, no untracked files at 66712d4.**
- The dirty state the task spec describes (modified paths predating the run, untracked test/roles.test.ts, differences vs 3fd39cb) does NOT exist in this checkout and cannot be reproduced here. No other checkout was pointed to. The "predates the run, don't revert" statement does not apply here, and nothing was reverted.

## Hashes (c), sha256 as of now
- tests/pane.test.tsx: eec875fabcb37ce6009cc222c1cd9b60b2c3c774e9f233f10150f6ced775f4fb (must stay byte-identical)
- tests/fixture.ts: 4d47f1643c2dda355058491fa6ecbf97e546d310a40c08410146160b9ef620e1
- types/index.d.ts: 970568ef0eb1a4d1bb4191aba7ed2e38597af030b87de25d3e0ee12329c511fb

## Host declarations used for typecheck
- Source: the plugin-authoring skill's per-session file, `C:/Users/pc/AppData/Local/Temp/claude/bundled-skills/2.1.286/7240bbb865b57647132528b586346f15/plugin-authoring/types/claude-code.d.ts` (Claude Code 2.1.286), copied to `packages/claude-plugin/.claude/types/claude-code.d.ts`.
- sha256: fbdb5ac78dc4352eca6238b110aa98b277f7dde5ad2db0273127c1ac74011914
- `packages/claude-plugin/.claude/` is gitignored (.gitignore line 5), so the copy is not committed. Regenerate with `/plugin-types` or `CLAUDE_CODE_DTS=<skill file>`. It is not copied from any other mod.

## Results (post-205)
- `npm run typecheck` (plugin): exit 0, no output beyond the npm banner. tsc was found through the git common dir (main checkout `D:/Claude/agent-cockpit/node_modules`); no junction needed.
- `npm test` (plugin; palette + `claude plugin test .`): exit 0, 52 pass, 0 fail, 9 files, 4.93 s. This includes pane.test.tsx (3 pass). Full output is in the run log summary: bench, host-probe, layout, limits, motion, pane, raster, scheduler and tween suites all `(pass)`.
- Root `npm run typecheck` (tsc): exit 0, no errors. Root `npm test` (vitest 3.2.7): exit 0, 2 files / 13 tests passed (core.test.ts 9, milestone.test.ts 4). Run through a TEMPORARY junction `node_modules` -> `D:\Claude\agent-cockpit\node_modules`, removed afterwards with `rmdir`; confirmed gone.
- test/roles.test.ts: absent, not run.
- **Failures: none.**
- Warnings seen: git "LF will be replaced by CRLF" for `check.js` and `blitrate.txt` (line-ending noise only).

## Numbers
"Before" numbers are quoted from the existing files; they were not regenerated.
- BEFORE (baseline raster, frame-counter API), 140 cols, 2000 frames after 300 warm-up: COMBINED mean 0.256 ms, p95 0.315, max 0.795 (7 rasters), from `scripts/bench.ts`. `before-bench.txt` (`tests/bench.ts`): COMBINED mean 0.269 ms.
- BEFORE blit rate: 112 blits/s (16/s x 7 keys), per `blitrate.txt`.
- CURRENT (post-205), `npm run bench`: COMBINED mean 0.138 ms, p95 0.188, max 0.329 (10 rasters; hero 140x4 mean 0.114 ms).
- CURRENT (post-205), `npm run blitrate`, mock clock, 140 cols, 10 s:
  - live conservative: 54/s total (48% of 112). Per key: hero 12.8, pipeline 12.8, orbs 3.6, meters 3.6, divider 3.6, progress 3.5, spark 3.5, underline 3.5.
  - live full: 83.4/s total (74%).
  - offline: 2/s.
  - live with reduced motion: 2/s.

## Tooling vs the spec
| Spec item | Status |
| --- | --- |
| `register-ts.mjs` loader | Superseded: `tests/resolve-ts.mjs` is the loader and is used by `npm run bench`. No duplicate created. |
| `tests/tools.mjs` palette, typecheck, capture, probe | Already existed (TASK-201/205), kept. Added the missing `sha <file>` subcommand. |
| package.json scripts | Kept all. Added `check` (palette && typecheck && test). `test` stays `palette && claude plugin test .`. No dependencies added. |
| `tests/baseline-capture.ts` and `before/live-*.txt/json` | Skipped: would mislabel an "after" capture as "before". The existing `before/` dumps cover it. |
| Optional check of the before dumps against 3fd39cb via `git archive` | Not done. |
| Edits under hooks/ | None. |

## Verbatim output (iteration 2; run at HEAD 66712d4 plus the tools.mjs palette edit)
Failures: none (green). Every command below exited 0.

### plugin: npm run typecheck
```

> @cockpit/claude-plugin@0.1.0 typecheck
> node tests/tools.mjs typecheck

exit 0
```

### plugin: npm test (palette + claude plugin test .)
```

> @cockpit/claude-plugin@0.1.0 test
> node tests/tools.mjs palette && claude plugin test .

PROBE rasters@60 = {"count":10,"keys":["hero:60x4","divider:58x1","pipeline:56x2","progress:50x1","spark:47x1","underline:56x1","orb-sup:4x2","orb-lead:4x2","orb-w0:4x2","meters:56x3"]}
PROBE max serialized blit bytes per key @60 = {"perKey":{"hero":3893,"pipeline":1849,"divider":984,"progress":857,"spark":806,"underline":954,"orb-sup":184,"orb-lead":185,"orb-w0":183,"meters":2743},"worstKey":3893,"perFrameSum":12638}
PROBE 1s mock, instant blits @60 = {"blitsPerSec":53,"perKey":{"hero":12,"pipeline":12,"divider":4,"progress":4,"spark":4,"underline":4,"orb-sup":4,"orb-lead":3,"orb-w0":3,"meters":3},"maxInflight":1,"harnessElapsedMsFor1s":148.7}
PROBE press latency ms @60 (instant blits) = {"p50":7.02,"p95":8.86,"max":9.51}
PROBE slow host (500ms/blit) 1s @60 = {"started":20,"maxInflight":10,"inflightAtEnd":10}
PROBE press with 10 blits pending @60 (harness ms) = 9.61
PROBE rasters@140 = {"count":10,"keys":["hero:140x4","divider:72x1","pipeline:70x2","progress:64x1","spark:61x1","underline:70x1","orb-sup:4x2","orb-lead:4x2","orb-w0:4x2","meters:34x3"]}
PROBE max serialized blit bytes per key @140 = {"perKey":{"hero":9013,"pipeline":2297,"divider":1208,"progress":1081,"spark":1030,"underline":1178,"orb-sup":184,"orb-lead":185,"orb-w0":183,"meters":1687},"worstKey":9013,"perFrameSum":18046}
PROBE 1s mock, instant blits @140 = {"blitsPerSec":53,"perKey":{"hero":12,"pipeline":12,"divider":4,"progress":4,"spark":4,"underline":4,"orb-sup":4,"orb-lead":3,"orb-w0":3,"meters":3},"maxInflight":1,"harnessElapsedMsFor1s":102.8}
PROBE press latency ms @140 (instant blits) = {"p50":5.04,"p95":7.38,"max":7.94}

tests\bench.test.ts:
(pass) bench: all live rasters at 140 columns paint in < 4 ms mean per frame [1441.75ms]
PROBE slow host (500ms/blit) 1s @140 = {"started":20,"maxInflight":10,"inflightAtEnd":10}
PROBE press with 10 blits pending @140 (harness ms) = 6.25
PROBE hero blits during 500ms with deny, then 500ms accepting = {"duringDeny":4,"total":9,"note":"a deny drops the key, but the next 125 ms text render re-registers it: stale-deny guard needed"}
PROBE blits in 500ms after ui.unmount (all denied only by a real host) = {"blits":27,"uiCloseEvents":[]}
PROBE blits in 500ms after session.end = 0

tests\host-probe.test.tsx:
(pass) blit cadence, backpressure and latency @60 cols (current code) [507.04ms]
(pass) unresolved blits pile up @60 cols (current code has no backpressure) [620.09ms]
(pass) blit cadence, backpressure and latency @140 cols (current code) [277.43ms]
(pass) unresolved blits pile up @140 cols (current code has no backpressure) [588.17ms]
(pass) deny semantics: current code unregisters on any deny, stale or not [139.48ms]
(pass) lifecycle: what the plugin hears when the drawing or session goes away (current code) [102.53ms]

tests\layout.test.tsx:
(pass) width() counts wide characters as two cells [2.37ms]
(pass) no Text line exceeds bodyColumns: live, terminal and desktop, 60/100/140 [432.59ms]
(pass) no Text line exceeds bodyColumns: offline, terminal and desktop, 60/100/140 [101.35ms]

tests\limits.test.ts:
(pass) resolveCadence: unset, invalid and valid COCKPIT_CADENCE [2.85ms]
(pass) trace off: record is a no-op and dump is empty [0.49ms]
(pass) trace on: fixed-size per-key ring wraps and keeps the newest events [0.92ms]
(pass) HOST_LIMITS: every field tagged, documented fields cited [1.62ms]

tests\motion.test.tsx:
(pass) live @140 conservative: <=60 blits/s total, Tier A <=30 fps each, text tick <=10 fps [918.81ms]
(pass) a host that never resolves: at most one blit in flight per key [2315.49ms]
(pass) zero blits after session.end [98.38ms]
(pass) a key that leaves the render is not blitted from the next tick [151.63ms]
(pass) idle (offline): <=2 blits/s in total, text tick <=1 fps [206.28ms]
(pass) idle (no active run): <=2 blits/s in total, text tick <=1 fps [267.95ms]
(pass) COCKPIT_REDUCED_MOTION=1: animation time frozen, status changes still render [133.56ms]
(pass) progress eases between snapshots of one run, snaps on a run switch [379.07ms]
(pass) tweens snap on remount (no host unmount event: a render gap past the idle beat resets them) [199.68ms]

tests\pane.test.tsx:
(pass) pane draws offline at every width [216.46ms]
(pass) pane draws live at every width [402.63ms]
(pass) a refused launch shows a failure card with the fix [119.90ms]

tests\raster.test.ts:
(pass) every painter returns exactly cols*rows*12 bytes at every width, deterministically [55.50ms]
(pass) orb paints any size, including 1x1 and 8x4 [0.89ms]
(pass) frame-rate independence: 16 ms and 33 ms clocks give identical frames at shared instants [452.61ms]
(pass) animation depends on time: moving painters differ across a second, static ones do not [2.84ms]
(pass) <=512 distinct fg/bg pairs per frame at 140 columns [19.71ms]
(pass) hero stays <=512 pairs over 200 timestamps, alert on/off, 4 and 6 rows [803.53ms]
(pass) pipeline: integer phase drives glyphs, fractional fill only paints the connector [0.86ms]

tests\scheduler.test.ts:
(pass) (a) never-resolving host: in-flight <=1 per key over 5 s, skipped not queued [9.74ms]
(pass) deny still unregisters the key [0.92ms]
(pass) (b) zero blits after close and after end [1.96ms]
(pass) (c) dropped key is not blitted from the next tick [1.90ms]
(pass) (d) timer stops when there are no live keys [0.69ms]
(pass) (e) 140-col live set for 10 s: <=60 blits/s total, Tier A <=30 fps, far below 112 [12.47ms]
(pass) (f) watchdog: refused period kills the interval, re-arm, late old-gen resolve ignored [1.01ms]
(pass) (g) stale deny does not unregister the replacement [0.58ms]
(pass) (h) degrade halves Tier A and restores after 2 s healthy [1.62ms]
(pass) (i) idle: <=2 fps per key with motion off, back to frame rate on motion [1.41ms]
(pass) idle: every one of 10 keys paints within ~1 s of mounting with motion off [0.92ms]
(pass) deny unregisters even after an unrelated generation bump [0.53ms]
(pass) a blit pending past the stall age is aborted so the key can paint again [1.89ms]
(pass) panes() polling: <=1 Hz, only idle or degraded, never while healthy and moving [2.58ms]
(pass) urgent repaint uses the reserve and still respects one pending slot [0.71ms]

tests\tween.test.ts:
(pass) endpoints and monotonic easing [4.96ms]
(pass) retarget starts from the sampled value, not the old target [0.75ms]
(pass) per-channel colour: red -> blue midpoint [1.23ms]
(pass) run-id isolation, run switch snap, reset, motion off snap [0.74ms]

 52 pass
 0 fail
Ran 52 tests across 9 files. [4.94s]
exit 0
```

### root: npm run typecheck
```

> agent-cockpit@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit

exit 0
```

### root: npm test (vitest; TEMPORARY node_modules junction to D:/Claude/agent-cockpit/node_modules, removed afterwards with cmd rmdir, confirmed gone, target intact)
```

> agent-cockpit@0.1.0 test
> vitest run


 RUN  v3.2.7 C:/Users/pc/.agent-cockpit/worktrees/ebf4b7b4/agent-cockpit/TASK-301

(node:41652) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8692) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
warning: in the working copy of 'check.js', LF will be replaced by CRLF the next time Git touches it
 ✓ test/core.test.ts (9 tests) 18ms
warning: in the working copy of 'check.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'check.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'check.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'check.js', LF will be replaced by CRLF the next time Git touches it
 ✓ test/milestone.test.ts (4 tests) 11023ms
   ✓ first vertical milestone > runs the full hierarchy with parallel isolated workers, review correction, integration and approval  3822ms
   ✓ first vertical milestone > REQUEST CHANGES continues the same run with a new planning round  2939ms
   ✓ first vertical milestone > survives an orchestrator restart and resumes from the database  2100ms
   ✓ first vertical milestone > detects an undeclared file overlap at runtime and lets the lead resolve it  2161ms

 Test Files  2 passed (2)
      Tests  13 passed (13)
   Start at  19:51:59
   Duration  11.83s (transform 329ms, setup 0ms, collect 1.12s, tests 11.04s, environment 0ms, prepare 240ms)

exit 0
```

### git status --short / git diff --stat (at end of this iteration; at start both were empty)
```
 M packages/claude-plugin/tests/tools.mjs
 packages/claude-plugin/tests/tools.mjs | 23 ++++++++++++++---------
 1 file changed, 14 insertions(+), 9 deletions(-)
```

### palette modes (tests/tools.mjs)
File args check only those files (basename theme.ts exempt) with /#[0-9a-fA-F]{6}\b/. No args scans hooks/*.ts(x) and requires theme.ts, raster.ts, register.tsx, and literals in theme.ts.
```
$ node tests/tools.mjs palette /tmp/seed.ts   # seeded violation: const a = "#ff00aa"
FAIL C:/Users/pc/AppData/Local/Temp/seed.ts has palette literals (theme.ts only)
exit 1
$ node tests/tools.mjs palette
exit 0
```

## Loader check
`tests/resolve-ts.mjs` (used by `npm run bench`) resolves extensionless siblings: /tmp/lt/b.ts doing `import {a} from './a'` run with the bench loader flags printed:
```
loader ok 1
exit 0
```

## Before-dump provenance and windows
before/ dumps were committed in 77e081d (TASK-205), captured by tests/capture.ts against the pre-redesign hooks (see tests/evidence/baseline/README.txt and raster.baseline.txt/register.baseline.txt snapshots). Not re-verified against 3fd39cb via git archive.
Blit-rate window: scripts/blitrate.ts uses a 10 s window after 1 s settle, not the spec's 5 s; rates are per second so comparable.
