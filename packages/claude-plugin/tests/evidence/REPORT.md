# TASK-205 evidence: benchmark, before/after dumps, validation run, criteria-to-proof

**Status: validation evidence only. Nothing ships.** Default `COCKPIT_CADENCE` stays `'conservative'`. Gate 0 is PENDING (section 5).

## 0. Environment for every number below: ALL NUMBERS PROVISIONAL
| Item | Value |
|---|---|
| Node | v22.14.0 (bench/capture scripts use `--experimental-transform-types`) |
| OS / CPU | Windows 11 Pro 10.0.26200 (win32/x64), AMD Ryzen 7 7800X3D 8-core (16 threads), 64 GiB |
| Engine | Claude Code 2.1.286 (`claude plugin test`) |
| Mock clock | `mock.clock(on)` from `claude-code/testing`; blit-rate window = 10 s after 1 s settle; bench uses real `performance.now()`, frame f = f x 16 ms |
| COCKPIT_CADENCE | unset => `conservative` (default) everywhere except the explicitly labelled `full` supplemental row in 2.3 |
| COCKPIT_TRACE | unset (off) everywhere, except the probe run in 4.5 (`COCKPIT_TRACE=1`) |
| COCKPIT_REDUCED_MOTION | unset, except the labelled reduced-motion row in 2.3 |
| Terminal | none. No live terminal exists in this session. |

All timings are harness/Node numbers on one dev machine, one run each: PROVISIONAL, not a host measurement.

## 1. Tooling notes
- `run` skill loaded. No project skill under `.claude/skills` launches this app. The TUI recipe needs `tmux` (not installed on Windows) and the pane is a mod inside an interactive Claude Code session; this session is non-interactive. **No real terminal screenshot was possible.** The dumps in section 3 are decoded Raster cells from the test harness at mock t=0, not terminal paints.
- Typecheck needs `CLAUDE_CODE_DTS=D:/Claude/agent-cockpit/packages/claude-plugin/.claude/types/claude-code.d.ts` (the gitignored engine types) and finds tsc via the main checkout. Root runs used a temporary `node_modules` junction to the main checkout, removed afterwards.
- Raw outputs below have ANSI colour codes stripped and are otherwise unedited.

## 2. Numbers
### 2.1 Paint bench at 140 columns (2000 frames after 300 warm-up; `npm run bench`, full raw output in 4.3)
Rasters are the 10 that register.tsx mounts for the LIVE fixture at 140 cols (sizes from `after/live-140.json`).

| Painter | mean ms | p95 ms | max ms |
|---|---|---|---|
| hero 140x4 | 0.120 | 0.163 | 0.347 |
| divider 72x1 | 0.002 | 0.003 | 0.099 |
| pipeline 70x2 | 0.004 | 0.005 | 0.098 |
| progress 64x1 | 0.003 | 0.004 | 0.100 |
| spark 61x1 | 0.003 | 0.004 | 0.066 |
| underline 70x1 | 0.004 | 0.007 | 0.118 |
| meters 34x3 | 0.003 | 0.004 | 0.115 |
| orb-sup / orb-lead / orb-w0 4x2 | 0.001 | 0.001-0.002 | 0.007-0.099 |
| **COMBINED (AFTER, 10 rasters)** | **0.143** | **0.190** | **0.367** |
| **COMBINED (BEFORE, baseline, 7 rasters)** | **0.267** | **0.342** | **1.605** |

Budget < 4 ms: PASS with ~28x margin. The earlier 0.28 ms baseline figure is consistent (0.267 ms here). Inside the `claude plugin test` runtime the same paint set measures about 1.2 ms/frame (tests/bench.test.ts, 1529-1596 ms for 1300 frames, includes a JS base64 shim): still < 4 ms but with a 3x margin, not 28x.

### 2.2 Pre-change baseline
112 blits/s = 16/s x 7 keys (TASK-101 appendix, "Baseline"; also `tests/evidence/before-bench.txt`).

### 2.3 Blit rate, LIVE fixture at 140 columns (`npm run blitrate`, mock clock, 10 s window)
```text
blit-rate: mock clock, 10 s window after 1 s settle, 140 columns, baseline before this work = 112 blits/s (16/s x 7 keys)
live {"COCKPIT_CADENCE":"conservative"}: total 54/s (48% of 112) per key {"orb-lead":3.6,"hero":12.8,"orb-w0":3.6,"pipeline":12.8,"meters":3.6,"divider":3.6,"progress":3.5,"spark":3.5,"underline":3.5,"orb-sup":3.5}
live {"COCKPIT_CADENCE":"full"}: total 83.4/s (74% of 112) per key {"pipeline":20.9,"underline":5.3,"orb-sup":5.2,"hero":20.8,"orb-lead":5.2,"orb-w0":5.2,"meters":5.2,"divider":5.2,"progress":5.2,"spark":5.2}
offline {"COCKPIT_CADENCE":"conservative"}: total 2/s (2% of 112) per key {"hero":2}
live {"COCKPIT_CADENCE":"conservative","COCKPIT_REDUCED_MOTION":"1"}: total 2/s (2% of 112) per key {"hero":2}
```
- Conservative: **54 blits/s total (48% of 112)**, within the 60 budget. Per key: hero 12.8, pipeline 12.8, the other eight 3.5-3.6.
- Hero/pipeline reach about 13/s, not the 30/s Tier A cap: the 60/s total is shared with eight slower keys. Observation, not a defect.
- The `full` row is supplemental only (not the default): 83.4/s.
- Offline and reduced motion: 2/s, hero only.

## 3. Before/after decoded cell dumps (LIVE fixture, harness mock t=0)
Produced by `npm run capture` (scripts/capture.ts). BEFORE = baseline register+raster compiled only in a scratch dir; AFTER = current hooks.
| | 60 cols | 140 cols |
|---|---|---|
| before | `before/live-60.txt`, `.json` (7 rasters) | `before/live-140.txt`, `.json` (7 rasters) |
| after | `after/live-60.txt`, `.json` (10 rasters) | `after/live-140.txt`, `.json` (10 rasters) |

`.txt` = per raster: char grid plus fg and bg hex grids per row. `.json` = `cells[row][col] = [codepoint, fg, bg]` plus the base64 payload and props. Distinct colour pairs, before -> after, 140 cols: hero 458 -> 146, progress 49 -> 11, pipeline 19 -> 17, spark 2 -> 2; new rasters divider 1, underline 2, meters 22 (all < 512 per raster).

## 4. Raw validation output
### 4.1 plugin typecheck (`npm --prefix packages/claude-plugin run typecheck`)
```text

> @cockpit/claude-plugin@0.1.0 typecheck
> node tests/tools.mjs typecheck

exit=0
```

### 4.2 plugin test (`npm --prefix packages/claude-plugin test`)
```text

> @cockpit/claude-plugin@0.1.0 test
> node tests/tools.mjs palette && claude plugin test .

PROBE rasters@60 = {"count":10,"keys":["hero:60x4","divider:58x1","pipeline:56x2","progress:50x1","spark:47x1","underline:56x1","orb-sup:4x2","orb-lead:4x2","orb-w0:4x2","meters:56x3"]}
PROBE max serialized blit bytes per key @60 = {"perKey":{"hero":3893,"pipeline":1849,"divider":984,"progress":857,"spark":806,"underline":954,"orb-sup":184,"orb-lead":185,"orb-w0":183,"meters":2743},"worstKey":3893,"perFrameSum":12638}
PROBE 1s mock, instant blits @60 = {"blitsPerSec":53,"perKey":{"hero":12,"pipeline":12,"divider":4,"progress":4,"spark":4,"underline":4,"orb-sup":4,"orb-lead":3,"orb-w0":3,"meters":3},"maxInflight":1,"harnessElapsedMsFor1s":191.8}
PROBE press latency ms @60 (instant blits) = {"p50":7.47,"p95":13.01,"max":14.74}
PROBE slow host (500ms/blit) 1s @60 = {"started":20,"maxInflight":10,"inflightAtEnd":10}
PROBE press with 10 blits pending @60 (harness ms) = 9.33
PROBE rasters@140 = {"count":10,"keys":["hero:140x4","divider:72x1","pipeline:70x2","progress:64x1","spark:61x1","underline:70x1","orb-sup:4x2","orb-lead:4x2","orb-w0:4x2","meters:34x3"]}
PROBE max serialized blit bytes per key @140 = {"perKey":{"hero":9013,"pipeline":2297,"divider":1208,"progress":1081,"spark":1030,"underline":1178,"orb-sup":184,"orb-lead":185,"orb-w0":183,"meters":1687},"worstKey":9013,"perFrameSum":18046}
PROBE 1s mock, instant blits @140 = {"blitsPerSec":53,"perKey":{"hero":12,"pipeline":12,"divider":4,"progress":4,"spark":4,"underline":4,"orb-sup":4,"orb-lead":3,"orb-w0":3,"meters":3},"maxInflight":1,"harnessElapsedMsFor1s":113.7}
PROBE press latency ms @140 (instant blits) = {"p50":5.87,"p95":7.48,"max":7.96}

tests\bench.test.ts:
(pass) bench: all live rasters at 140 columns paint in < 4 ms mean per frame [1528.81ms]
PROBE slow host (500ms/blit) 1s @140 = {"started":20,"maxInflight":10,"inflightAtEnd":10}
PROBE press with 10 blits pending @140 (harness ms) = 7.79
PROBE hero blits during 500ms with deny, then 500ms accepting = {"duringDeny":4,"total":9,"note":"a deny drops the key, but the next 125 ms text render re-registers it: stale-deny guard needed"}
PROBE blits in 500ms after ui.unmount (all denied only by a real host) = {"blits":27,"uiCloseEvents":[]}
PROBE blits in 500ms after session.end = 0

tests\host-probe.test.tsx:
(pass) blit cadence, backpressure and latency @60 cols (current code) [573.61ms]
(pass) unresolved blits pile up @60 cols (current code has no backpressure) [657.93ms]
(pass) blit cadence, backpressure and latency @140 cols (current code) [301.33ms]
(pass) unresolved blits pile up @140 cols (current code has no backpressure) [587.37ms]
(pass) deny semantics: current code unregisters on any deny, stale or not [149.91ms]
(pass) lifecycle: what the plugin hears when the drawing or session goes away (current code) [94.76ms]

tests\layout.test.tsx:
(pass) width() counts wide characters as two cells [2.19ms]
(pass) no Text line exceeds bodyColumns: live, terminal and desktop, 60/100/140 [499.96ms]
(pass) no Text line exceeds bodyColumns: offline, terminal and desktop, 60/100/140 [113.52ms]

tests\limits.test.ts:
(pass) resolveCadence: unset, invalid and valid COCKPIT_CADENCE [2.18ms]
(pass) trace off: record is a no-op and dump is empty [0.32ms]
(pass) trace on: fixed-size per-key ring wraps and keeps the newest events [0.61ms]
(pass) HOST_LIMITS: every field tagged, documented fields cited [1.39ms]

tests\motion.test.tsx:
(pass) live @140 conservative: <=60 blits/s total, Tier A <=30 fps each, text tick <=10 fps [1029.02ms]
(pass) a host that never resolves: at most one blit in flight per key [2369.70ms]
(pass) zero blits after session.end [103.48ms]
(pass) a key that leaves the render is not blitted from the next tick [143.82ms]
(pass) idle (offline): <=2 blits/s in total, text tick <=1 fps [216.73ms]
(pass) idle (no active run): <=2 blits/s in total, text tick <=1 fps [245.11ms]
(pass) COCKPIT_REDUCED_MOTION=1: animation time frozen, status changes still render [135.64ms]
(pass) progress eases between snapshots of one run, snaps on a run switch [490.99ms]
(pass) tweens snap on remount (no host unmount event: a render gap past the idle beat resets them) [247.05ms]

tests\pane.test.tsx:
(pass) pane draws offline at every width [218.20ms]
(pass) pane draws live at every width [515.92ms]
(pass) a refused launch shows a failure card with the fix [96.66ms]

tests\raster.test.ts:
(pass) every painter returns exactly cols*rows*12 bytes at every width, deterministically [54.33ms]
(pass) orb paints any size, including 1x1 and 8x4 [0.56ms]
(pass) frame-rate independence: 16 ms and 33 ms clocks give identical frames at shared instants [556.66ms]
(pass) animation depends on time: moving painters differ across a second, static ones do not [2.32ms]
(pass) <=512 distinct fg/bg pairs per frame at 140 columns [25.59ms]
(pass) hero stays <=512 pairs over 200 timestamps, alert on/off, 4 and 6 rows [847.37ms]
(pass) pipeline: integer phase drives glyphs, fractional fill only paints the connector [0.84ms]

tests\scheduler.test.ts:
(pass) (a) never-resolving host: in-flight <=1 per key over 5 s, skipped not queued [6.91ms]
(pass) deny still unregisters the key [0.71ms]
(pass) (b) zero blits after close and after end [1.76ms]
(pass) (c) dropped key is not blitted from the next tick [2.48ms]
(pass) (d) timer stops when there are no live keys [0.44ms]
(pass) (e) 140-col live set for 10 s: <=60 blits/s total, Tier A <=30 fps, far below 112 [13.70ms]
(pass) (f) watchdog: refused period kills the interval, re-arm, late old-gen resolve ignored [0.93ms]
(pass) (g) stale deny does not unregister the replacement [0.58ms]
(pass) (h) degrade halves Tier A and restores after 2 s healthy [1.41ms]
(pass) (i) idle: <=2 fps per key with motion off, back to frame rate on motion [1.44ms]
(pass) idle: every one of 10 keys paints within ~1 s of mounting with motion off [0.84ms]
(pass) deny unregisters even after an unrelated generation bump [0.34ms]
(pass) a blit pending past the stall age is aborted so the key can paint again [1.87ms]
(pass) panes() polling: <=1 Hz, only idle or degraded, never while healthy and moving [2.22ms]
(pass) urgent repaint uses the reserve and still respects one pending slot [0.83ms]

tests\tween.test.ts:
(pass) endpoints and monotonic easing [4.32ms]
(pass) retarget starts from the sampled value, not the old target [0.57ms]
(pass) per-channel colour: red -> blue midpoint [1.24ms]
(pass) run-id isolation, run switch snap, reset, motion off snap [0.63ms]

 52 pass
 0 fail
Ran 52 tests across 9 files. [5.23s]
exit=0
```

### 4.3 plugin bench (`npm --prefix packages/claude-plugin run bench`)
```text

> @cockpit/claude-plugin@0.1.0 bench
> node --experimental-transform-types --no-warnings --import ./tests/resolve-ts.mjs scripts/bench.ts

bench: node v22.14.0, win32/x64, BENCH_N=2000

AFTER (hooks/raster.ts): 2000 frames after 300 warm-up, 140 columns
painter           mean ms   p95 ms   max ms  bytes(b64)
hero 140x4         0.120    0.163    0.347  8960
divider 72x1       0.002    0.003    0.099  1152
pipeline 70x2      0.004    0.005    0.098  2240
progress 64x1      0.003    0.004    0.100  1024
spark 61x1         0.003    0.004    0.066  976
underline 70x1     0.004    0.007    0.118  1120
meters 34x3        0.003    0.004    0.115  1632
orb-sup 4x2        0.001    0.001    0.099  128
orb-lead 4x2       0.001    0.002    0.077  128
orb-w0 4x2         0.001    0.001    0.007  128
COMBINED           0.143    0.190    0.367  (budget: mean < 4 ms) PASS

BEFORE (baseline raster, frame-counter API): 2000 frames after 300 warm-up, 140 columns
painter           mean ms   p95 ms   max ms  bytes(b64)
hero 140x4         0.239    0.311    1.576  8960
pipeline 70x2      0.008    0.012    0.076  2240
progress 64x1      0.006    0.008    0.104  1024
spark 61x1         0.007    0.010    0.145  976
orb-sup 4x2        0.003    0.004    0.087  128
orb-lead 4x2       0.003    0.004    0.123  128
orb-w0 4x2         0.002    0.003    0.082  128
COMBINED           0.267    0.342    1.605  (budget: mean < 4 ms) PASS

before combined mean 0.267 ms (7 rasters) vs after 0.143 ms (10 rasters)
exit=0
```

### 4.4 plugin capture (`npm --prefix packages/claude-plugin run capture`)
```text

> @cockpit/claude-plugin@0.1.0 capture
> node --experimental-transform-types --no-warnings scripts/capture.ts

wrote tests/evidence/before/live-60.txt and .json: hero(60x4,215 pairs) pipeline(56x2,17 pairs) progress(50x1,39 pairs) spark(47x1,1 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,4 pairs)
wrote tests/evidence/before/live-140.txt and .json: hero(140x4,458 pairs) pipeline(70x2,19 pairs) progress(64x1,49 pairs) spark(61x1,2 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,4 pairs)
wrote tests/evidence/after/live-60.txt and .json: hero(60x4,101 pairs) divider(58x1,1 pairs) pipeline(56x2,17 pairs) progress(50x1,11 pairs) spark(47x1,1 pairs) underline(56x1,2 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,4 pairs) meters(56x3,22 pairs)
wrote tests/evidence/after/live-140.txt and .json: hero(140x4,146 pairs) divider(72x1,1 pairs) pipeline(70x2,17 pairs) progress(64x1,11 pairs) spark(61x1,2 pairs) underline(70x1,2 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,4 pairs) meters(34x3,22 pairs)
exit=0
```

### 4.5 plugin probe (`COCKPIT_TRACE=1 npm --prefix packages/claude-plugin run probe`)
```text

> @cockpit/claude-plugin@0.1.0 probe
> node --experimental-transform-types --no-warnings scripts/probe.ts

## HOST_LIMITS
- blitRate: 120 [default] d.ts:2178-2180 (scope unstated) scope=plugin
- shownFps: 60 [documented] d.ts:2178-2180
- payloadCap: null [default] d.ts:2184-2187 (deny reasons only; no cap stated) scope=cols*rows*3 words
- colorPairCap: 1024 [default] none scope=unverified
- clockMinMs: 1 [documented] d.ts:3228-3231
- panesPollMaxHz: 1 [default] d.ts:2308-2319 (cost unstated)
- fps30Achievable: null [default] none

## CADENCE conservative
{"totalPerSec":60,"tierAFps":30,"tierBFps":15,"urgentReserve":0.1,"framePeriodMs":16,"idlePeriodMs":500}

## TRACE (on=true)
(no events recorded in this process)
exit=0
```

The probe runs in a bare Node process that never blits, so the trace ring is empty ("no events recorded in this process"). There is no exported trace artifact to build a Gate 0 report from (finding F1).

### 4.6 root `npm run typecheck`
```text

> agent-cockpit@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit

exit=0
```

### 4.7 root `npm test`
```text

> agent-cockpit@0.1.0 test
> vitest run


 RUN  v3.2.7 C:/Users/pc/.agent-cockpit/worktrees/ebf4b7b4/agent-cockpit/TASK-205

(node:16436) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:47504) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ test/core.test.ts (9 tests) 14ms
warning: in the working copy of 'check.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'check.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'check.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'check.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'check.js', LF will be replaced by CRLF the next time Git touches it
 ✓ test/milestone.test.ts (4 tests) 11077ms
   ✓ first vertical milestone > runs the full hierarchy with parallel isolated workers, review correction, integration and approval  3870ms
   ✓ first vertical milestone > REQUEST CHANGES continues the same run with a new planning round  2882ms
   ✓ first vertical milestone > survives an orchestrator restart and resumes from the database  2114ms
   ✓ first vertical milestone > detects an undeclared file overlap at runtime and lets the lead resolve it  2210ms

 Test Files  2 passed (2)
      Tests  13 passed (13)
   Start at  19:37:55
   Duration  11.75s (transform 249ms, setup 0ms, collect 877ms, tests 11.09s, environment 0ms, prepare 258ms)

exit=0
```

### 4.8 pane.test.tsx hash and diff
```text
eec875fabcb37ce6009cc222c1cd9b60b2c3c774e9f233f10150f6ced775f4fb *tests/pane.test.tsx
eec875fabcb37ce6009cc222c1cd9b60b2c3c774e9f233f10150f6ced775f4fb *tests/pane.test.tsx
```

The two hashes are identical: **match**.
```text
exit=0
```

`git diff --exit-code` real result: **exit 0** (no diff against the index). The brief says the file was modified before this round; in this worktree its only commit is `3fd39cb Initial commit` and its hash equals `baseline/pane.test.sha256`, so no modification is visible here.

## 5. Gate 0 (human-owned): all 7 items PENDING
Not measured, because no live terminal exists in this session. Harness numbers above are supplemental only and satisfy no item.
| # | Item (HOST_LIMITS field) | Status |
|---|---|---|
| 1 | live delivered fps (`shownFps`, `fps30Achievable`) | PENDING |
| 2 | input latency | PENDING |
| 3 | CPU | PENDING |
| 4 | real layout | PENDING |
| 5 | blit scope (`blitRate` scope: plugin / key / global) | PENDING |
| 6 | payload cap (`payloadCap`) | PENDING |
| 7 | colour-pair scope (`colorPairCap`) | PENDING |

The default CADENCE remains `'conservative'`. Nothing ships; a Gate 0 report built from an exported trace, or a written human waiver per item, is still required.

## 6. Acceptance criterion -> proof
Test names are in `packages/claude-plugin/tests/`. All pass in 4.2 (52 tests, 9 files). GAP = not proven.
| Criterion | Proof |
|---|---|
| Frame-rate independence | raster.test.ts: "frame-rate independence: 16 ms and 33 ms clocks give identical frames at shared instants"; "animation depends on time: moving painters differ across a second, static ones do not" |
| Pure painters, exact word count | raster.test.ts: "every painter returns exactly cols*rows*12 bytes at every width, deterministically" |
| Backpressure, one in-flight per key | scheduler.test.ts "(a) never-resolving host: in-flight <=1 per key over 5 s, skipped not queued"; motion.test.tsx "a host that never resolves: at most one blit in flight per key" |
| Deny handling | scheduler.test.ts "deny still unregisters the key", "(g) stale deny does not unregister the replacement", "deny unregisters even after an unrelated generation bump" |
| Idle / offline / no active run | motion.test.tsx "idle (offline)" and "idle (no active run): <=2 blits/s in total, text tick <=1 fps"; scheduler.test.ts "(i) idle: <=2 fps per key with motion off ..."; evidence 2.3 (offline 2/s) |
| COCKPIT_REDUCED_MOTION | motion.test.tsx "COCKPIT_REDUCED_MOTION=1: animation time frozen, status changes still render"; evidence 2.3 (2/s) |
| Tween unit tests | tween.test.ts (4 tests); motion.test.tsx "progress eases between snapshots of one run, snaps on a run switch", "tweens snap on remount ..." |
| Single theme module | `npm test` runs `tools.mjs palette` first (no hex literals outside hooks/theme.ts); passes in 4.2 |
| New rasters (divider, underline, meters) | raster.test.ts painter cases (divider, underline, meters); mounted in after/*.json |
| Painter size tests at 1 and 140 cols | raster.test.ts "every painter returns exactly cols*rows*12 bytes at every width", "orb paints any size, including 1x1 and 8x4" |
| Colour pairs <= 512 | raster.test.ts "<=512 distinct fg/bg pairs per frame at 140 columns", "hero stays <=512 pairs ..."; pair counts in section 3 |
| Bench < 4 ms | scripts/bench.ts (2.1, 4.3); tests/bench.test.ts "bench: all live rasters at 140 columns paint in < 4 ms mean per frame" |
| Blit rate vs 112 baseline | 2.3 (54/s conservative); motion.test.tsx "live @140 conservative: <=60 blits/s total, Tier A <=30 fps each, text tick <=10 fps"; scheduler.test.ts "(e) ..." |
| pane.test.tsx unchanged | 4.8 (hash match, git diff exit 0); the file's 3 tests pass in 4.2 |
| Button keys / layout / breakpoints | pane.test.tsx "pane draws ... at every width"; layout.test.tsx "no Text line exceeds bodyColumns ... 60/100/140". Hotkeys have no dedicated new test (GAP, F3) |
| Before/after evidence | section 3 files |
| Watchdog regression | scheduler.test.ts "(f) watchdog: refused period kills the interval, re-arm, late old-gen resolve ignored"; "a blit pending past the stall age is aborted so the key can paint again" (see F2) |
| Zero blits after close / end | scheduler.test.ts "(b) zero blits after close and after end"; motion.test.tsx "zero blits after session.end" |
| Vanished key | scheduler.test.ts "(c) dropped key is not blitted from the next tick"; motion.test.tsx "a key that leaves the render is not blitted from the next tick" |
| Timer stops | scheduler.test.ts "(d) timer stops when there are no live keys" |
| HOST_LIMITS tagged, 1:1 with Gate 0 | limits.test.ts "HOST_LIMITS: every field tagged, documented fields cited"; probe output 4.5 |
| Trace off => no output; ring wrap | limits.test.ts "trace off: record is a no-op and dump is empty", "trace on: fixed-size per-key ring wraps and keeps the newest events" |
| Trace export round-trip (JSON, command, ui.close/session.end) | **GAP** (F1) |
| Trace-off export writes no file | **GAP** (F1) |
| Root typecheck / test green | 4.6, 4.7 |
| Gate 0 report / CADENCE evidence | **PENDING** (section 5) |

## 7. Findings (reported, not fixed; hooks are outside this task's scope)
- **F1 (owner: whichever task owns hooks/limits.ts and the Observability amendment; TASK-202/TASK-204 scope): trace export is missing.** limits.ts has only the text `dump()`. There is no JSON export {version, cadence, hostLimits, keys}, no `/cockpit trace` command, no export on ui.close/session.end, and no round-trip or trace-off-no-file test. The `cockpit` command is registered but its description lists only start/stop/run/status/approve/changes/reject/report. Consequence: the probe and GATE0.md have no exported artifact to consume, so a Gate 0 report cannot be built from a trace yet. The brief says the Lead reports back before going further on this.
- **F2 (owner: TASK-202 scheduler): stall abort versus the TASK-101 agreement.** The appendix ("Interface agreements") says a stalled blit must NOT release `pending`, because host blits cannot be cancelled. scheduler.test.ts "a blit pending past the stall age is aborted so the key can paint again" and "(f)" expect the scheduler to abort and send a new blit (>= 2 blits for a never-resolving host over 8 s). The host-side count of unresolved requests for one key can therefore exceed 1 over time. The Lead should decide whether "at most one in-flight per key" is measured scheduler-side or host-side.
- **F3 (minor, owner: TASK-204): the hotkeys s,n,a,c,r,e,i,1,2,3,j,k,p,t,x have no dedicated test** beyond pane.test.tsx.
- Housekeeping: package.json was edited, outside the listed scope (`bench` now runs scripts/bench.ts; new `blitrate` script). tests/bench.ts (the older bench) is now unused and left in place.

## 8. Commands
`npm --prefix packages/claude-plugin run typecheck | test | bench | capture | blitrate | probe`. `bench` reads the baseline files in `tests/evidence/baseline/`; it writes and removes `raster.baseline.run.ts` there at run time.

---

# Appendix: TASK-101 evidence (historical, unchanged)

Engine: Claude Code 2.1.286. Declarations: `claude-code.d.ts` written by the plugin-authoring skill (cited as `d.ts:<line>`).
Each fact is tagged **[doc]** (declared), **[measured]** (probe in this repo, mock clock) or **[open]**.

## 1. Tooling (verified)
- `plugin-authoring` loaded via Skill. `run` skill loaded via Skill: no project skill under `.claude/skills` covers launching this app; its TUI recipe needs `tmux`, which is not installed (Windows), and the session is non-interactive, so the mod cannot be launched in a real terminal. **Live-terminal validation is incomplete and escalated (section 4).** The captures below are harness snapshots, NOT an equivalent of a live capture. Hot reload is off in this session (non-interactive); irrelevant to tests.
- Host test runner: `claude plugin test .` (`claude plugin test --help`: runs every `*.test.ts(x)` under dir, one child per file). Discovers unchanged `pane.test.tsx` (3 pass) plus new files.
- Typecheck: `tsc` is not installed in the worktree (no node_modules). `tests/tools.mjs` finds it by walking up and via `git rev-parse --git-common-dir`, or `TSC=`. Engine types go in `.claude/types/claude-code.d.ts` (gitignored); if absent set `CLAUDE_CODE_DTS` to the skill's `types/claude-code.d.ts`, or run `/plugin-types`.
- `pane.test.tsx` has a pre-existing type error against this build (`on('process.run')` returns a bare result, the type wants `{ value }`). It must stay unchanged, so `tsconfig.json` excludes it. `hooks/` and the new tests typecheck clean.
- Tests have no fs/process/env: capture and probe run generated copies in a scratch dir and print tagged lines that `tools.mjs` stores in `tests/evidence/`.
- `bench.ts` runs on node 22.14 with `--experimental-transform-types` (raster.ts uses a TS-only class feature) and shims `Uint8Array.toBase64` (host has it, node 22.14 does not).

## 2. Host limits
| Item | Result |
|---|---|
| `$.clock.every` minimum | **[doc]** "at least 1" ms (d.ts:3198 block). **[measured]** every(1) fired 100x in 100 mock ms; every(0) was accepted and fired 10x in 10 ms (clamp assumed, undocumented: do not use 0). Each period is one host dispatch; a refused period ends the interval. |
| Monotonic time | **[measured]** `performance` global exists in plugin env (d.ts:13635 `{ now(): number }`); monotonic across ticks. It is real time: it advanced 20 ms while mock clock advanced 100 ms, so it does NOT follow `mock.clock`. `$.clock.now()` (async, epoch ms) does follow it. |
| Blit limit scope | **[doc]** number only, scope undocumented: see 2b. |
| Blit payload | **[doc]** dimension limits only, no byte cap: see 2b. **[measured]** worst serialized blit @140: 9013 B. |
| Colour pairs | **[doc]** number only (1024), scope undocumented: see 2b. |
| Blit result | `{}` or `{ deny }`; deny reasons: not mounted, size mismatch, bad cells. Resize is a redraw (`$.ui.invalidate("ui.render")`), not a blit. |
| Invalidate | **[doc]** redraw at most 10/s, 30/s for the shown pane (folds). |
| Test APIs | `mock.clock(on)` -> `{now, advance, set, settle, sleep}`; `mock.env`, `mock.store`; mount handle `drawn/find/findAll/press/input/advance/resize/redraw/unmount`; `on('ui.blit')` beneath the plugin intercepts blits (count, delay, deny); `find({type:'Raster'}).props.cells` exposes cells. `ui.advance` moves only a `Client`'s frame clock, not plugin `$.clock` timers. |

## 2b. Host limit verification and binding constraints
Searched: `claude-code.d.ts` (whole file; grep for rate/second/fold/palette/distinct/payload/bytes/KiB/MiB/limit near blit, Raster, Image, frame), `plugin-authoring/reference.md` (grep blit/palette/colour pair/120/sixty/fold), `plugin-authoring/examples/` (no Raster or blit example exists), and the repo's own docs (only this report mentions blit). No host source is mounted in the tree. Findings, quoted (d.ts = `types/claude-code.d.ts` of this build):

| Topic | Host evidence (quoted) | What it does NOT say |
|---|---|---|
| Blit rate | d.ts:2178-2180 "The surface paints the cells or source at its next frame, so blits between frames fold into one: up to 120 a second taken, some sixty shown." d.ts:4886 (Image) "The surface writes them with its frames, some sixty a second". | Whether 120/s is per key, per plugin, per pane or per terminal. Whether a folded blit still resolves `{}`. |
| Redraw rate | d.ts:2166-2168 `$.ui.invalidate`: "at most ten a second, thirty for the shown pane and the band (calls sooner fold)". | n/a (text redraw, not blit). |
| Payload | d.ts:8438 "How many terminal columns wide, 1 to 512"; rows "1 to 256" (d.ts:8444); d.ts:8447 cells = "standard padded base64 of `columns * rows` little-endian u32 triplets"; deny reasons d.ts:2185 "not mounted, not this plugin's, another size, cells that do not decode, a bad source". d.ts:4957 caps an **Image** source at 2 MiB (not a Raster). | Any byte cap on a Raster blit. The implied ceiling 512*256*12 B = 1.5 MiB raw is not a documented limit. |
| Colour pairs | d.ts:8428-8429 "its palette paints 1024 distinct color pairs at once and the rest as their nearest." | What "at once" spans: one Raster, one frame, the pane, or the terminal. |

Decision rule (Supervisor): a documented number overrides the default for that number; undocumented scope falls back to the labelled constraint. Result:

| Limit | Value in `HOST_LIMITS` | Basis |
|---|---|---|
| Blit rate | **100/s shared by all keys**, token bucket (burst 10), plus strict 1 in flight per key | **SUPERVISOR CONSTRAINT (unverified host behaviour)**. The documented 120/s "taken" (d.ts:2179) is an upper bound of unknown scope; 100 is below it, so the documented number does not override it. |
| Payload | **64 KiB (65536 B) serialized per blit**, warn at 48 KiB (49152 B) | **SUPERVISOR CONSTRAINT (unverified host behaviour)**; no host cap documented. |
| Colour pairs | **512 distinct fg/bg pairs per pane**, shared by all keys of the pane. Host ceiling recorded: 1024 | Number: **[doc]** 1024 (d.ts:8429) overrides the Supervisor's undocumented-default 64; 512 is 50% of it as headroom because the scope is unverified. Scope = pane and the 50% margin are **SUPERVISOR CONSTRAINT (unverified host behaviour)**. To use the Supervisor's literal 64 change `pairs.perPane` (one line); the baseline already uses 538 pairs at 140 columns, so 64 means roughly 8x fewer shades per ramp. |

Single config object (the scheduler and the pair-count test import it; a verified host value is a one-line edit):
```ts
export const HOST_LIMITS = {
  blit:    { sharedPerSec: 100, burst: 10, maxStarveMs: 1000, inFlightPerKey: 1, hostTakenPerSec: 120, hostShownPerSec: 60 },
  payload: { maxBytes: 65536, warnBytes: 49152 },
  pairs:   { perPane: 512, hostCeiling: 1024 },
  raster:  { maxCols: 512, maxRows: 256 },
} as const
```
**Rate behaviour**: one token bucket across all keys, refilled at `sharedPerSec`. Each tick, eligible keys (registered, not pending, not stalled, due by tier) are served in order of staleness (oldest last-accepted first, i.e. round-robin by staleness). A key waiting longer than `maxStarveMs` (1 s) moves to the front; with 7 keys at 100/s this holds with wide margin, and if demand ever exceeds the bucket the Tier B keys are slowed first, never starved past 1 s.

**Payload measurement (harness, 140 columns, `host-probe.txt`)**: serialized blit args (`JSON.stringify` chars, including requestId/key/columns/cells) per key: hero 9013 B (8.8 KiB; 13.7% of 64 KiB, 18% of the 48 KiB line), pipeline 2297, progress 1081, spark 1030, orbs 184-185 each; one frame of all 7 keys sums to 13973 B. At 60 columns: hero 3893 B, frame sum 7957 B. Headroom is large today. A single blit reaches 48 KiB at about 3068 cells (about 140x21), so any new raster (telemetry, divider, tabs) must stay under that.
**Size is fixed by dimensions, not by content.** A Raster carries exactly 3 little-endian u32 words per cell (d.ts:8447), so raw bytes = `12 * cols * rows`, base64 = `16 * cols * rows` chars, and the serialized blit = `16 * cols * rows + ~53` chars of JSON overhead (check: hero 140x4 = 8960 + 53 = 9013 B, matching the measurement). Flatter backgrounds, fewer gradient levels or fewer styling runs change the colour values but NOT the byte count; they are not a payload mitigation. (They still matter for the colour-pair budget below.) Cell budget: 48 KiB = 49152 B is reached at `(49152 - 53) / 16` = 3068 cells (about 140x21); 64 KiB at 4094 cells.
**Allowed responses to payload pressure (never silent truncation)**, evaluated by the scheduler from `cells.length + overhead` before sending:
1. Bandwidth: bytes/s = blit bytes x blits/s. Over the 48 KiB warn line, that key's rate is halved (and counted in the shared bucket); report once.
2. Over the 64 KiB cap: reject the frame (not sent), keep the last good frame on screen, mark the key oversized, report once. Cells are never cut or padded.
3. Dimension reduction is the only way to shrink a payload and it is NOT automatic: size changes are a redraw (`ui.render` with new `columns`/`rows`; "a resize is a redraw", d.ts:8393-8394), so it needs an explicitly agreed layout path (the layout owner shrinks the Raster in `register.tsx`). Until that is agreed, rule 2 applies. Design rule: no Raster larger than 140 columns x 20 rows.
Painters therefore have no `detail` parameter: their signature stays `(…size, t, data)`.
**Colour-pair behaviour**: painters quantize gradients through `theme.ts` ramps (default 32 levels). If the per-pane distinct pairs of the last frame exceed `pairs.perPane`, the next frame is painted with every ramp at half the levels (32 -> 16 -> 8), choosing nearest entries by index: deterministic, no randomness, and the blit is never failed. A test counts pairs from the live fixture at 140 columns against `HOST_LIMITS.pairs.perPane`.

### Host limit verification backlog
| Limit | Default used | Evidence searched | Live test that would confirm it |
|---|---|---|---|
| Blit rate scope (shared vs per key/plugin/terminal) | 100/s shared token bucket | d.ts:2178-2180; reference.md:87-88; no example, no host source mounted | Run N=1, 4, 8 keys blitting unthrottled for 30 s in a real terminal (`claude --debug`); compare accepted/s per key and in total (acceptance, not display). Total flat while per-key falls = shared; per-key flat = per key. Whether accepted blits are displayed stays covered by the blocked displayed-cadence row. |
| Taken vs shown (folding) | 120 taken, ~60 shown | d.ts:2179 | Blocked pending a verified displayed-frame observation (see gate). Acceptance side only: count accepted `{}` per second from the scheduler trace and check folded blits still resolve `{}`. |
| Raster blit byte cap | 64 KiB (warn 48 KiB; size = 16*cols*rows + ~53) | d.ts:8438-8447 (dimensions only), d.ts:4957 (Image 2 MiB, other element) | Blit one 512x256 Raster (1.5 MiB raw) and a ladder of 16, 32, 48, 64, 128 KiB; record the first `deny` or latency jump. |
| Raster dimensions | 1..512 x 1..256 | d.ts:8438-8444 **[doc]** | none needed; deny on mismatch is documented at d.ts:2185 |
| Colour pairs: number | 1024 documented, 512 used | d.ts:8428-8429 | Paint 1100 distinct pairs in one Raster, then split across 2 Rasters of one pane; compare to a capture to see where "nearest" substitution begins. |
| Colour pairs: scope | per pane | d.ts:8428-8429 does not say | As above, across two panes / two Rasters, via `tmux capture-pane -e`. |
| Raster unmount/hide signal | blit deny only; poll `$.ui.panes()` | d.ts:3198 block, d.ts:6757-6790, reference.md | Close/hide the pane while blitting; log whether any hook fires and when the first deny arrives. |
| `$.clock.every(ms)` real minimum | 16 ms driver | d.ts:3198 "at least 1" **[doc]**; harness: every(1) fires | Measure the achieved period of every(16) over 60 s in a real session (jitter p95). |

## 3. Baseline (current code, mock clock)
Raster keys: hero, pipeline, progress, spark, orb-sup, orb-lead, orb-w0 (7). Sizes @60: 60x4, 56x2, 50x1, 47x1, 4x2 x3. @140: 140x4, 70x2, 64x1, 61x1, 4x2 x3.
- Cadence: 16 blits/s/key = 112/s total, all unconditionally, even if idle-looking. Close to the 120/s ceiling; leaves no room for any other blit.
- Backpressure: with a host that takes 500 ms per blit, 112 blits started in 1 s, **63 concurrent in flight**, 56 pending at end (unbounded queue).
- Deny: the first deny drops the key, but the next text re-render (125 ms tick while moving) re-registers it, so a late deny from a previous size/run can drop a fresh registration (no generation guard).
- Harness press time: `performance.now()` elapsed around `ui.press` 4.5 ms p50 / 6.5 ms p95 (7.4-11.6 ms with 56 blits pending). Elapsed wall time inside the test harness, not terminal input latency.
- Harness elapsed time for 1 s of mock animation (112 blits): ~92-106 ms. This is wall time of `clock.advance(1000)` including scheduling, mocks and awaits; it is NOT CPU consumption. CPU measurement is unavailable (tests have no `process.cpuUsage`/fs; no verified host tooling) and is escalated.
- Paint cost (`before-bench.txt`): combined mean 0.27 ms, p95 0.34 ms at 140 cols (hero 0.23 ms). Budget is 4 ms, so there is large headroom; the real constraints are blit rate and pair count.
- Harness snapshots (`before-60.txt`, `before-140.txt`; live and offline fixtures, mock t=0, terminal surface): every element's props as JSON, and for every Raster its dimensions, full base64 `cells` payload, glyph rows and every decoded `cp:fg:bg` triplet. They show what the mod hands the surface, not what a terminal paints or how it lays out.

## 4. Live validation: unavailable here, with reasons and attempts
Disposition (Supervisor): "unavailable in this environment" for delivered cadence, terminal input latency, true CPU consumption and live 60/140-column captures. Nothing below is estimated or invented; all numbers elsewhere in this report are harness-only.
| Metric | Why unavailable here | Attempted |
|---|---|---|
| Live captures 60/140 cols | The Raster is terminal-only and can only be seen through a real terminal frontend; this session has no PTY host and cannot be driven interactively (the engine reported "Mod hot-reloading is off in this session (nobody could be asked)"). | `Skill run` (loaded); scan of `.claude/skills/*/SKILL.md` up the tree (none); `which tmux screen` (both absent; only Windows Terminal `wt` exists, which this tool cannot drive or read back). `claude --plugin-dir` was not attempted: it needs an interactive TTY. |
| Delivered (displayed-frame) cadence | Needs an observation of frames the terminal actually shows; no such mechanism is verified (see gate). Acceptance counts can be traced but are not displayed frames. The test kit never paints and `on('ui.blit')` stands for the engine. | Harness probe only (`host-probe.test.tsx`: counts blits entering `ui.blit`, deterministic on `mock.clock`). |
| Input-to-paint latency | Needs a keypress and the first appearance of its specific response in a real terminal. | Harness `ui.press` elapsed time only (`performance.now()`; not latency). |
| CPU consumption | The test sandbox has no `process.cpuUsage`/fs/process; `performance.now()` deltas are wall time. | None possible; no host tooling is exposed to tests. `claude` is present on this machine (2.1.286) and runs `plugin test/validate`, but not an interactive session. The reviewing environment has no `claude` binary at all, so even the harness tests cannot be re-run there. |

## Live validation gate: REQUIRED BEFORE any task that changes rendering cadence or ships to users
**Status: OPEN.** It closes only when a host-capable environment (real terminal + PTY driver, e.g. tmux on Linux/macOS or a scripted ConPTY driver on Windows, with `claude` installed) runs the procedures below and records results in `tests/evidence/live-*.md`. Harness numbers stay labelled harness-only and never substitute. Preconditions for every run: `claude --plugin-dir packages/claude-plugin --debug`, `COCKPIT_DATA_DIR` pointing at the live and offline fixtures, 140- and 60-column terminals, machine otherwise idle, machine and terminal noted.
| Metric | Procedure (command, duration, sampling) | Pass threshold |
|---|---|---|
| Submission / acceptance rate (scheduler behaviour, NOT displayed frames) | Active run (live fixture), pane focused. Scheduler trace (`COCKPIT_TRACE=1`, to be added by the scheduler worker: one debug line per second with blits sent, accepted `{}`, denied, skipped per key). 60 s steady state after a 10 s warm-up at 140 columns, then 60 s idle (offline fixture), 3 repetitions. `{}` only means "the cells are its next frame" (d.ts:2184): blits between frames fold, so accepted/s can exceed what is shown (d.ts:2179 "up to 120 a second taken, some sixty shown"). | Verifies the scheduler only: submitted and accepted blits/s per key within +-10% of the scheduler's own target; total <= 100/s; idle <= 2 per key. Passing this says nothing about delivered cadence. |
| Delivered (displayed-frame) cadence | **BLOCKED pending host tooling.** No verified observation mechanism exists: the plugin cannot see paints (blit resolves on acceptance), `tmux capture-pane` polling samples a coalesced screen and cannot count frames, and the declarations/docs do not say how the terminal surface delimits frames. Unverified candidate to validate first: tap the PTY byte stream (`tmux pipe-pane` with timestamps) and count writes that change a Raster region, after calibrating against a test Raster toggling at a known rate (e.g. 10, 30 and 60 Hz) to show the method recovers it and where it saturates. Alternatively a host-exposed frame counter/trace. | No threshold can be claimed until a mechanism is verified. The "+-10% of target" criterion applies to displayed cadence only after that. Gate stays OPEN for this metric. |
| Input-to-paint latency | Per input, define in advance a specific expected response: a marker string that exists only in the target state, read from the harness tree of that state (e.g. the tab content rendered after `tab-events` versus `tab-tasks`), located in a stable region that excludes every Raster row and all animated text (spinners, pulses, clocks, time-ago labels). Per trial: capture the region and require the marker ABSENT (discard the trial otherwise, so a stale or unrelated frame cannot satisfy it); record `t_send` from a monotonic clock immediately before the PTY write (tmux `send-keys`; ConPTY write on Windows); poll the region with `capture-pane -p` every <=5 ms; `t_seen` = first poll containing the marker; latency = `t_seen - t_send`. Alternate between two states so each press has a distinct marker; 200 trials at random 0.3-1 s spacing, 140 columns, animation active (and once with `COCKPIT_REDUCED_MOTION=1`); report the poll resolution as measurement error and exclude trials that never show the marker (count them as failures). | p95 < 50 ms (also record p50, max, failures). |
| Plugin CPU | Per-process OS CPU time, not wall time: Linux `/proc/<pid>/stat` utime+stime, Windows `(Get-Process -Id <pid>).TotalProcessorTime`, or `process.cpuUsage()` from a sampler attached to the process; every claude process in the tree. Read at the start and end of a 60 s steady-state active-run window, 3 runs, minus a control run of the same session with the plugin disabled. | (plugin run - control) CPU time / 60 s < 5% of one core. |
| Live captures | `tmux capture-pane -e -p` (keeps ANSI fg/bg) at 60 and 140 columns for the live and offline fixtures, with `COCKPIT_REDUCED_MOTION=1` for a deterministic frame; stored as `tests/evidence/live-before-{60,140}.ansi`. | Every cell carries its fg and bg; no line wider than the terminal; text layout matches the harness snapshot (`before-*.txt`) tree; before/after diff reviewed by a human. |
Also run the "Host limit verification backlog" live tests in the same session; their results replace the matching constraints in `HOST_LIMITS`.

## 5. Interface agreements (for scheduler/painter/tween workers)

### Time
- `type Now = () => number` returns monotonic animation ms. Host default `performance.now()`. Tests cannot inject into the plugin env directly, and `performance.now` ignores `mock.clock`, so: the plugin reads `$.env.get('COCKPIT_ANIM_CLOCK')`; `'wall'` makes the scheduler derive `t` from `await $.clock.now()` each tick (mock-controlled), otherwise `performance.now()`. Tests set it with `mock.env`. pane.test.tsx sets nothing and gets perf time.
- Wall time (`$.clock.now()`) stays for timestamps/labels only.
- Reduced motion (`COCKPIT_REDUCED_MOTION=1`, read in `locate`): ambient `t` is a constant (0); tweens snap.

### Painters (raster.ts, pure, no module state)
- `fn(…size, t: number /*ms*/, data): string` (base64, exactly cols*rows*3 u32). Speeds in rad/s or cells/s, never per frame.
- Examples: `hero(cols, rows, t, info)`, `pipeline(cols, t, info)`, `progress(cols, t, fill, live)`, `spark(cols, rows, t, values, live)`, `orb(t, color, active, seed)`. New: `divider(cols, t)`, `tabs(cols, t, data)`, `telemetry(cols, rows, t, data)`.
- Callers pass already-interpolated values (`fill`, `values`, colours); painters never read tween state.
- Write `Uint32Array` words directly; no per-cell arrays. Colours come only from `theme.ts`; gradients quantized to ~32 levels; <= `HOST_LIMITS.pairs.perPane` (512) distinct fg/bg pairs across all rasters of the pane per frame.
- Bench (`tests/bench.ts`) will switch from `f` to `t = f*60` when painters change; keep export names so it needs one edit.

### Pipeline
- `PipelineInfo = { steps: string[]; phase: number /*discrete: label + active node + failure semantics*/; fill: number /*interpolated 0..steps.length-1, display only*/; failed: boolean; color: number }`. The active node is drawn from `phase`, never from `fill`, so it stays visible mid-transition.

### Tween store (tween.ts)
- `type Tween = { from: number|number[]; to: number|number[]; startMs: number; durMs: number }`; key = `runId + ':' + element`. `sample(key, target, t, opts): value` creates/retargets (new `from` = value sampled at `t`), ease-out cubic, 400-700 ms. Colours interpolate per RGB channel. `snap(key|prefix)` for run switch (user-initiated), unmount, idle, reduced motion. Pure given `(store, t)`; the store is a module-level object owned by the caller (register.tsx), not raster.ts.

### Lifecycle (verified against declarations and probes)
Host notifications that exist: `session.start` (d.ts:3993; fires again after hot reload, module vars reset, pending waits of the old env cancelled, d.ts:3198 block); `ui.render` per redraw (d.ts:3692); `session.end` (d.ts:4085; runs inside one short bound, `next.budget`; reason `clear` keeps the process under a new session id with NO new `session.start`); `session.attach/detach` (clients); `ui.close` hook with origin `plugin|person|unload` (d.ts:6761-6790; `unload` is already gone and the opener's hooks do not run); `$.ui.panes()` lists the plugin's panes with shown/placed (poll only); timers return a Timer with `.cancel()`.
Not exposed: any notification for a Raster unmounting, a pane being hidden/scrolled out, resize (other than a new `ui.render`), or a tab/run switch inside our own pane. The only signal that a Raster is gone is a `{ deny }` on blit (not mounted / size mismatch). **[measured]** after `ui.unmount()` and after `session.end` the current code keeps blitting (56 blits/500 ms and 63 blits/500 ms): nothing stops its timers.
Scheduler contract:
- **start**: lazily, on the first `ui.render` that registers a Raster (not only `session.start`, which does not fire after `/clear` or in a pane opened later). One driver `$.clock.every(16)`; guard against a second start with a module flag keyed to the Timer. Hot reload resets module state, so `session.start` must call `stop()` then re-arm lazily.
- **reconcile**: every `ui.render` replaces the desired set `{key -> {cols, rows, tier, paint}}`; keys absent from the last render are removed; a key whose size/run/remount changed gets `gen++`. Pending is tracked per key outside this map.
- **remove**: on deny with matching gen, on absence from a render, on `ui.close`(plugin/person) for the pane id, and on `session.end`. Removal never cancels an in-flight blit; it leaves `pending` set until its `finally`, and its result is ignored (gen mismatch).
- **stop**: when the registry is empty for >~2 s (cancel the Timer: no Raster means no reason to wake), and on `session.end` (`stop()` + clear registry + clear tweens). An idle scheduler keeps no 16 ms timer.
- **restart**: next `ui.render` with Rasters; `gen` keeps counting (never reset) so stale denies from before a stop cannot match; pending keys from before the stop still skip frames until their promises settle.
- **unresolved blits across generations**: `pending: Map<key, token>` lives outside the render-rebuilt registry, so removal, re-registration, `gen++`, resize, run switch, `stop()` and `session.end` never touch it. A key with an entry in `pending` issues no new request, whatever its gen or registration state: strictly at most one request in flight per key, no queue.
- **request identity**: each send creates `token = {}` and does `pending.set(key, token)`; the `finally` of that request runs `if (pending.get(key) === token) pending.delete(key)`, so an old promise can never clear a newer request's entry. Deny handling is separate: `if (res.deny && reg.get(key)?.gen === sentGen) reg.delete(key)`.
- **watchdog (observe only)**: `$.ui.blit` takes no `signal`/cancel (d.ts:2194 `blit(args) => Promise<UiBlitResult>`), so a blit cannot be verified cancelled. A pending age > ~2 s therefore must NOT release `pending`. It may only: record the key as `stalled` (stop scheduling it, so it paints nothing new), count the miss toward half-rate degradation, and report once (`$.ui.status`/debug). The key becomes eligible again only when its own promise settles. Total unsettled requests are bounded by the number of distinct keys (7 today), so they cannot accumulate.
- **required scheduler test** (to be written by the scheduler worker, on `on('ui.blit')` holding one blit via `clock.sleep` > 2 s): (1) register key K, let it send blit #1 and hold it; (2) advance 2.5 s: assert exactly 1 request started for K and K is reported stalled; (3) remove K (drop it from a render), re-register it (same size, then a new size, then a run switch) and advance more: assert still exactly 1 request started for K and `maxInflight` for K is 1; (4) release blit #1: assert that only then a new request starts, that the old `finally` did not clear the newer token (hold request #2 and assert no #3 starts), and that a stale deny from #1 does not unregister the new generation.
- **Escalated**: the host offers no unmount/hide/resize notification for Rasters, so hidden-pane detection relies on denies and optionally polling `$.ui.panes()` (isShown) at idle rate; Supervisor to confirm that is acceptable.

### Scheduler (scheduler.ts, module-level, survives re-render)
Consistent with the Lifecycle contract above; all limits come from `HOST_LIMITS` (section 2b).
- `register(key, { cols, rows, tier: 'A'|'B'|'static', paint: (t) => string })` reconciles by key; `gen` increments on a new key, size change, run switch or remount.
- `pending: Map<key, token>` outside the render-rebuilt registry. A key with an entry skips its frame and never queues. Send: `const token = {}; pending.set(key, token)`; cleanup in `finally`: `if (pending.get(key) === token) pending.delete(key)` (identity-guarded: an old request can never clear a newer one).
- Deny unregisters only if the `gen` captured at send still equals the current one.
- Watchdog marks a key `stalled` (no new frames, reported once) and never releases `pending`; the key resumes only when its own promise settles.
- Budget: `HOST_LIMITS.blit` token bucket (100/s shared, burst 10), staleness-ordered service, no key starved > 1 s, strict 1 in flight per key. Tier A (hero, pipeline, progress) up to 16 ms period, Tier B (divider, tab underline, spark, orbs, telemetry) <=15 fps, static only on data/size change. Repeated frame-budget misses degrade to half rate. Payload handling (rate halving over 48 KiB, frame rejection over 64 KiB) and colour-pair quantization as in 2b. Idle (no motion for the displayed run, offline, unfocused, no Raster surface or reduced motion): <=2 fps or on change only; text tick <=1 fps (active <=10 fps).
- Single `$.clock.every(16)` driver; stop with `.cancel()` (Timer has `cancel()`, not callable); see Lifecycle for start/stop.
- Motion eligibility derives from the displayed run (not `activeRun(snapshot)`) and is recomputed during render.

## 6. Commands
`npm --prefix packages/claude-plugin run typecheck | test | bench | capture | probe` (probe/capture write `tests/evidence/*`; `capture <label>` writes `<label>-60.txt`/`-140.txt`, default `before`). Full chain verified passing.

## 7. Gate 0 amendment (supersedes the blit-rate row of 2b where they differ)
- Gate 0 is human-owned and does not block implementation; workers continue on `claude-code/testing` with the mock clock. All section 4 items stay OPEN until a human runs the probe or waives each item in writing.
- Scheduler exposes `CADENCE = 'conservative' | 'full'`, default `'conservative'`: total <= 60 blits/s, Tier A <= 30 fps per key. `'full'`: 90/s total, Tier A <= 70/s, <= 60 fps per key. Constants only, no code-path change; only a Gate 0 report or human waiver may flip the default. Tests cover both under the mock clock.
- `HOST_LIMITS.blit.sharedPerSec: 100` in 2b is the unverified upper bound; the active `CADENCE` budget (60 or 90) is what the scheduler enforces. The documented host figure (120 taken / ~60 shown, d.ts:2179) is unchanged.
- Payload contract (cols*rows*3 words, <= 140x8 raster cap, size-mismatch refusal test) is binding; baseline max is 140x4 (9013 B serialized). No discrepancy claimed.
- Baseline cadence of current code (16/s x 7 keys = 112/s) already exceeds both profiles' totals: the scheduler worker must throttle.

