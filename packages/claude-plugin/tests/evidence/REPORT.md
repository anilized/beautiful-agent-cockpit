# TASK-406 final validation: root gates, bench, after dumps, blit rate, scope proof

> **Update (after merge):** the blit budget the Supervisor accepted is applied. Under the mock clock the live pane at 140 columns now
> requests **97 blits/s** in total (hero 62/s, each other animated key 7/s), down from 375/s; offline 1/s, reduced motion 0/s
> (`tests/evidence/blitrate.txt`). `COCKPIT_CADENCE`, `hooks/limits.ts`, the legacy scheduler and `scripts/probe.ts` were removed
> as dead code. The 375/s figures below are the state before that fix. Open live-terminal checks: `GATE0.md`.


**Status: evidence only. Every gate below is green (all commands exited 0, no failures). Every number is PROVISIONAL** (harness and plain-Node numbers, see section 0). Nothing here is a live-host measurement. This report replaces the stale TASK-307 report, which described the removed Gate 0 / CADENCE design.

One finding needs a decision (section 3): under the mock clock the live pane requests **375 blits/s at 140 cols (6 keys x 62.5/s), 3.35x the old 112/s baseline**, while the d.ts says the host takes at most 120/s. Whether that cap is global or per key could not be verified here.

## 0. Environment for every number: ALL PROVISIONAL
| Item | Value |
|---|---|
| Node | v22.14.0 (`--experimental-transform-types`) |
| OS / CPU | Windows 11 Pro 10.0.26200 x64, AMD Ryzen 7 7800X3D 8-Core Processor, one dev machine, one run each |
| Engine | `claude plugin test` (Claude Code CLI; test kit `claude-code/testing`) |
| Mock clock | `mock.clock(on)`; blit rate = 10 s window after a 1 s settle, 140 cols, blits resolve instantly (`{}`); capture stamps t = 0, 500, 1056 ms; bench uses real `performance.now()`, 2000 iterations, 140 cols |
| Env flags | none set, except `COCKPIT_REDUCED_MOTION=1` on the labelled reduced-motion row |
| Typecheck types | `CLAUDE_CODE_DTS=C:/Users/pc/.claude/mods/hud/.claude/types/claude-code.d.ts` (the worktree has no `.claude/types`, which is gitignored) |
| Root gates | via a TEMPORARY `node_modules` junction to `D:\Claude\agent-cockpit\node_modules`, removed with `rmdir` afterwards (confirmed gone, target still intact) |
| Terminal | none: no interactive terminal or tmux in this environment. No screenshots exist. |

Raw outputs below have ANSI colour codes and git LF/CRLF warnings stripped and are otherwise unedited.

## 1. Acceptance criteria -> proof
| Criterion | Proof (test name or artifact) | Result |
|---|---|---|
| Frame-rate independence (same t, different tick rates, identical output) | raster.test.ts `frame-rate independence: 16 ms and 33 ms clocks give identical frames at shared instants`; scheduler.test.ts `rs clock: identical time across simulated tick rates (real source and async-anchored fallback)`, `rs clock: fallback follows measured deltas and re-anchors (not frames * period)`, `rs: active loop runs at 16 ms and paints with the host clock, not a frame count` | pass (2.3) |
| Backpressure: unresolved blit skipped not queued; deny unregisters | scheduler.test.ts `rs: unresolved blit is skipped not queued: <=1 in flight per key`, `rs: in-flight guard survives renders that rebuild the map`, `rs: deny unregisters the key and stops the timer`, `rs: a stale deny from a replaced entry does not drop its replacement`; motion.test.tsx `a host that never resolves: at most one blit in flight per key`, `a denied key is unregistered while the others keep painting`; fallback.test.tsx `a blit the host denies unregisters its key and is not hammered; a never-resolving blit is skipped` | pass |
| 33 ms fallback | scheduler.test.ts `rs: >half unresolved falls back to 33 ms, restores to 16 ms after 2 s healthy`, `rs: healthy host never degrades` | pass |
| Idle / offline / reduced-motion rate drops on the mock clock | scheduler.test.ts `rs: idle (no active run)`, `rs: idle (offline)`, `rs: idle (reduced motion)` (<=2 blits/s per animated key, static keys never); motion.test.tsx `idle (offline): <=2 blits/s in total, text tick <=1 fps`, `idle (no active run): ...`, `COCKPIT_REDUCED_MOTION=1: animation time frozen, status changes still render`; measured table in section 3 | pass |
| Text tick <=10 fps active, <=1 fps idle | motion.test.tsx `live @140: 16 ms raster loop, every key <=62 blits/s, text tick <=10 fps` and the two idle tests above | pass |
| Tween: endpoints, monotonicity, reset on run switch | tween.test.ts `endpoints and monotonic easing`, `easing is monotonic over a dense sweep`, `run-id isolation, run switch snap, reset, motion off snap`, `sample: first sight and snap jump immediately; endpoints are exact`, `sample: dense sweep is monotonic and eases out`, `sample: runs are isolated; resetRun and reset drop state so a switch never eases`; motion.test.tsx `progress eases between snapshots of one run, snaps on a run switch`, `tweens snap on remount ...` | pass |
| Painters: base64 = cols*rows*12 bytes at 1, 60, 100, 140 cols; deterministic | raster.test.ts `every painter returns exactly cols*rows*12 bytes at every width, deterministically` (COLS = 1, 2, 40, 60, 100, 140) | pass |
| Pairs budget | raster.test.ts `<=512 distinct fg/bg pairs per frame at 140 columns`, `hero stays <=512 pairs over 200 timestamps, ...` | pass |
| Theme is the only palette source, no colour literals in raster.ts | `npm run palette` (2.2): exit 0 (scans hooks/*.ts(x) for `#rrggbb`, theme.ts exempt; BASELINE.md records the seeded-violation check) | pass |
| New rasters on terminal, text fallbacks on desktop | layout.test.tsx (Raster keys on terminal; none plus `▔` `▕` text on desktop); fallback.test.tsx `text fallbacks stay within bodyColumns (terminal)` / `(desktop)`, `desktop: no raster, no blits, hero and telemetry as text`; artifact: `after/live-*.txt` contain `divider`, `tab-underline`, `meters` | pass |
| No overflow of bodyColumns at 60/100/140 | layout.test.tsx `no Text line exceeds bodyColumns: live ...` and `offline ...`, terminal and desktop | pass |
| Hotkeys s n a c r e i 1 2 3 j k p t x preserved | fallback.test.tsx `hotkeys s n a c r e i 1 2 3 j k p t x each stay bound to their action` | pass |
| Combined 140-col paint < 4 ms | `npm run bench` (2.4): mean 0.167 ms; also tests/bench.test.ts | pass (PROVISIONAL, plain Node) |
| Existing pane.test.tsx passes unchanged | 3 pass in the plugin run; `git diff --exit-code` exit 0; sha256 equals BASELINE.md and `baseline/pane.test.sha256` (section 5) | pass |
| Root `npm run typecheck` and `npm test` green with output | sections 2.5, 2.6 | pass |
| Before/after decoded dumps at 60 and 140 cols | `tests/evidence/before/live-{60,140}.{txt,json}`, `tests/evidence/after/live-{60,140}.{txt,json}` (section 4) | present |
| Scope: only packages/claude-plugin changed by this run, outside-plugin diff hash == BASELINE.md | section 5 | pass |

## 2. Verbatim gate output
### 2.1 plugin: `npm run typecheck` (CLAUDE_CODE_DTS set)
```

> @cockpit/claude-plugin@0.1.0 typecheck
> node tests/tools.mjs typecheck

exit 0
```

### 2.2 plugin: `npm run palette`
```

> @cockpit/claude-plugin@0.1.0 palette
> node tests/tools.mjs palette

exit 0
```

### 2.3 plugin: `npm test` (palette, then `claude plugin test .`)
```

> @cockpit/claude-plugin@0.1.0 test
> node tests/tools.mjs palette && claude plugin test .

PROBE rasters@60 = {"count":10,"keys":["hero:60x4","divider:58x1","pipeline:56x2","progress:50x1","spark:47x1","tab-underline:56x1","orb-sup:4x2","orb-lead:4x2","orb-w0:4x2","meters:56x3"]}
PROBE max serialized blit bytes per key @60 = {"perKey":{"hero":3893,"divider":984,"pipeline":1849,"progress":857,"spark":806,"orb-w0":183},"worstKey":3893,"perFrameSum":8572}
PROBE 1s mock, instant blits @60 = {"blitsPerSec":372,"perKey":{"hero":62,"divider":62,"pipeline":62,"progress":62,"spark":62,"orb-w0":62},"maxInflight":1,"harnessElapsedMsFor1s":336.9}
PROBE press latency ms @60 (instant blits) = {"p50":7.68,"p95":18.83,"max":20.88}
PROBE slow host (500ms/blit) 1s @60 = {"started":12,"maxInflight":6,"inflightAtEnd":6}
PROBE press with 6 blits pending @60 (harness ms) = 8.84
PROBE rasters@140 = {"count":10,"keys":["hero:140x4","divider:72x1","pipeline:70x2","progress:64x1","spark:61x1","tab-underline:70x1","orb-sup:4x2","orb-lead:4x2","orb-w0:4x2","meters:34x3"]}
PROBE max serialized blit bytes per key @140 = {"perKey":{"hero":9013,"divider":1208,"pipeline":2297,"progress":1081,"spark":1030,"orb-w0":183},"worstKey":9013,"perFrameSum":14812}
PROBE 1s mock, instant blits @140 = {"blitsPerSec":372,"perKey":{"hero":62,"divider":62,"pipeline":62,"progress":62,"spark":62,"orb-w0":62},"maxInflight":1,"harnessElapsedMsFor1s":262.9}
PROBE press latency ms @140 (instant blits) = {"p50":6.92,"p95":11.11,"max":21.37}

tests\bench.test.ts:
(pass) bench: all live rasters at 140 columns paint in < 4 ms mean per frame [2076.78ms]
PROBE slow host (500ms/blit) 1s @140 = {"started":12,"maxInflight":6,"inflightAtEnd":6}
PROBE press with 6 blits pending @140 (harness ms) = 10.34
PROBE hero blits during 500ms with deny, then 500ms accepting = {"duringDeny":1,"total":1,"note":"a deny drops the key, but the next 125 ms text render re-registers it: stale-deny guard needed"}
PROBE blits in 500ms after ui.unmount (all denied only by a real host) = {"blits":186,"uiCloseEvents":[]}
PROBE blits in 500ms after session.end = 0

tests\fallback.test.tsx:
(pass) hotkeys s n a c r e i 1 2 3 j k p t x each stay bound to their action [987.18ms]
(pass) text fallbacks stay within bodyColumns (terminal): ▔ underline, ▕ meters, divider rule [161.15ms]
(pass) text fallbacks stay within bodyColumns (desktop): ▔ underline, ▕ meters, divider rule [115.93ms]
(pass) desktop: no raster, no blits, hero and telemetry as text [251.00ms]
(pass) a blit the host denies unregisters its key and is not hammered; a never-resolving blit is skipped [1919.26ms]
(pass) a late deny after session.end has no effect (no blits, no throw) [223.59ms]
(pass) session.end silences a live scheduler, a later render is inert, session.start re-enables [898.05ms]

tests\host-probe.test.tsx:
(pass) blit cadence, backpressure and latency @60 cols (current code) [830.63ms]
(pass) unresolved blits pile up @60 cols (current code has no backpressure) [464.69ms]
(pass) blit cadence, backpressure and latency @140 cols (current code) [520.51ms]
(pass) unresolved blits pile up @140 cols (current code has no backpressure) [411.96ms]
(pass) deny semantics: current code unregisters on any deny, stale or not [232.20ms]
(pass) lifecycle: what the plugin hears when the drawing or session goes away (current code) [188.07ms]

tests\layout.test.tsx:
(pass) width() counts wide characters as two cells [3.26ms]
(pass) no Text line exceeds bodyColumns: live, terminal and desktop, 60/100/140 [620.20ms]
(pass) no Text line exceeds bodyColumns: offline, terminal and desktop, 60/100/140 [231.23ms]

tests\limits.test.ts:
(pass) resolveCadence: unset, invalid and valid values [3.34ms]
(pass) readGates: all off by default, read once through the injected accessor [2.04ms]
(pass) trace off: no recording, no export, no file, no output [1.29ms]
(pass) export round-trip: mock host events over several keys, ring wrap keeps chronological order [2.21ms]
(pass) writeTrace without a data-dir write API returns the serialized dump [0.36ms]
(pass) HOST_LIMITS: exactly 7 tagged fields, each with a cite or none [1.39ms]

tests\motion.test.tsx:
(pass) live @140: 16 ms raster loop, every key <=62 blits/s, text tick <=10 fps [1970.46ms]
(pass) a denied key is unregistered while the others keep painting [263.40ms]
(pass) a host that never resolves: at most one blit in flight per key [1390.61ms]
(pass) zero blits after session.end [192.36ms]
(pass) a key that leaves the render is not blitted from the next tick [249.54ms]
(pass) idle (offline): <=2 blits/s in total, text tick <=1 fps [179.03ms]
(pass) idle (no active run): <=2 blits/s in total, text tick <=1 fps [218.54ms]
(pass) COCKPIT_REDUCED_MOTION=1: animation time frozen, status changes still render [131.51ms]
(pass) progress eases between snapshots of one run, snaps on a run switch [840.72ms]
(pass) tweens snap on remount (no host unmount event: a render gap past the idle beat resets them) [452.94ms]

tests\pane.test.tsx:
(pass) pane draws offline at every width [290.53ms]
(pass) pane draws live at every width [611.67ms]
(pass) a refused launch shows a failure card with the fix [140.31ms]

tests\raster.test.ts:
(pass) every painter returns exactly cols*rows*12 bytes at every width, deterministically [72.65ms]
(pass) orb paints any size, including 1x1 and 8x4 [1.04ms]
(pass) pairCount counts distinct fg/bg pairs [2.88ms]
(pass) frame-rate independence: 16 ms and 33 ms clocks give identical frames at shared instants [686.68ms]
(pass) animation depends on time: moving painters differ across a second, static ones do not [3.23ms]
(pass) <=512 distinct fg/bg pairs per frame at 140 columns [28.72ms]
(pass) hero stays <=512 pairs over 200 timestamps, alert on/off, 4 and 6 rows [1205.18ms]
(pass) pipeline: integer phase drives glyphs, fractional fill only paints the connector [0.67ms]
(pass) perf guard: all live painters at 140 columns stay well under the 4 ms budget (loose; tests/bench.ts is the real number) [487.79ms]

tests\scheduler.test.ts:
(pass) (a) never-resolving host: in-flight <=1 per key over 5 s, skipped not queued [10.70ms]
(pass) deny still unregisters the key [1.02ms]
(pass) (b) zero blits after close and after end [2.31ms]
(pass) (c) dropped key is not blitted from the next tick [2.38ms]
(pass) (d) timer stops when there are no live keys [1.30ms]
(pass) (e) 140-col live set for 10 s: <=60 blits/s total, Tier A <=30 fps, far below 112 [21.32ms]
(pass) (f) watchdog: refused period kills the interval, re-arm, late old-gen resolve does not clear the new slot [1.14ms]
(pass) (g) stale deny does not unregister the replacement [0.86ms]
(pass) (h) degrade halves Tier A and restores after 2 s healthy [1.84ms]
(pass) (i) idle: total <=2/s, hero only, back to frame rate on motion [1.22ms]
(pass) deny unregisters even after an unrelated generation bump [0.35ms]
(pass) a stalled blit keeps its slot: no second blit until it resolves [3.96ms]
(pass) burst cap: throughput near the refill rate at 16 ms and in idle at 500 ms [6.69ms]
(pass) makeSyncClock: sync reads, one prefetch in flight, local source advances [0.61ms]
(pass) panes() polling: <=1 Hz, only idle or degraded, never while healthy and moving [1.83ms]
(pass) urgent repaint uses the reserve and still respects one pending slot [2.14ms]
(pass) rs: active loop runs at 16 ms and paints with the host clock, not a frame count [0.99ms]
(pass) rs: unresolved blit is skipped not queued: <=1 in flight per key [0.85ms]
(pass) rs: a resolve frees the key for the next tick [0.40ms]
(pass) rs: in-flight guard survives renders that rebuild the map [0.40ms]
(pass) rs: deny unregisters the key and stops the timer [0.39ms]
(pass) rs: a stale deny from a replaced entry does not drop its replacement [0.40ms]
(pass) rs: key dropped by sync is not blitted from the next tick [0.46ms]
(pass) rs: timer exists only while keys are live; stop() cancels it and ignores late resolves [0.63ms]
(pass) rs: idle (no active run): <=2 blits/s per animated key, static keys never, mode readable [1.07ms]
(pass) rs: idle (offline): <=2 blits/s per animated key, static keys never, mode readable [0.90ms]
(pass) rs: idle (reduced motion): <=2 blits/s per animated key, static keys never, mode readable [0.74ms]
(pass) rs: idle with only static keys runs no timer and blits nothing [0.32ms]
(pass) rs: >half unresolved falls back to 33 ms, restores to 16 ms after 2 s healthy [1.07ms]
(pass) rs: healthy host never degrades [1.81ms]
(pass) rs: watchdog re-arms an interval the host ended [1.02ms]
(pass) rs clock: identical time across simulated tick rates (real source and async-anchored fallback) [2.95ms]
(pass) rs clock: fallback follows measured deltas and re-anchors (not frames * period) [0.66ms]
(pass) rs clock: frozen mode holds time and resumes without a jump [0.74ms]

tests\tween.test.ts:
(pass) endpoints and monotonic easing [15.63ms]
(pass) retarget starts from the sampled value, not the old target [3.77ms]
(pass) per-channel colour: red -> blue midpoint [1.67ms]
(pass) run-id isolation, run switch snap, reset, motion off snap [0.78ms]
(pass) settled / idle detection [0.69ms]
(pass) easing is monotonic over a dense sweep [42.22ms]
(pass) discrete phase stays integer while fill interpolates [1.49ms]
(pass) sample: first sight and snap jump immediately; endpoints are exact [0.38ms]
(pass) sample: dense sweep is monotonic and eases out [19.01ms]
(pass) sample: retargets from the sampled value, not the old target [0.41ms]
(pass) sample: colours ease per RGB channel [0.43ms]
(pass) sample: runs are isolated; resetRun and reset drop state so a switch never eases [0.34ms]
(pass) sample: motion off snaps every target [0.19ms]

 92 pass
 0 fail
Ran 92 tests across 10 files. [6.22s]
exit 0
```

### 2.4 plugin: `npm --prefix packages/claude-plugin run bench` (140 cols, 2000 iterations, plain Node)
```

> @cockpit/claude-plugin@0.1.0 bench
> node --experimental-transform-types --no-warnings --import ./tests/resolve-ts.mjs tests/bench.ts

bench: 2000 iterations, node v22.14.0, 140 columns
painter           mean ms   p95 ms   max ms  bytes(b64)
hero 140x4         0.136    0.180    0.581  8960
pipeline 136x2     0.007    0.009    0.222  4352
progress 100x1     0.005    0.006    0.119  1600
spark 60x1         0.003    0.004    0.111  960
divider 138x1      0.003    0.004    0.097  2208
underline 136x1    0.002    0.003    0.124  2176
meters 40x4        0.004    0.006    0.111  2560
orb 0 4x2          0.002    0.003    0.100  128
orb 1 4x2          0.002    0.003    0.101  128
orb 2 4x2          0.002    0.002    0.071  128
orb 3 4x2          0.002    0.002    0.076  128
COMBINED           0.167    0.219    0.611  (budget: mean < 4 ms) PASS
exit 0
```

Combined mean 0.167 ms (p95 0.219, max 0.611) against the 4 ms budget: about 24x margin. Earlier baseline (tests/evidence/before-bench.txt, 7 painters): combined mean 0.269 ms. Caveat: this is plain Node with native base64; inside `claude plugin test` the bench assertion test took about 2.08 s for its loop (JS base64 shim), so the margin inside the host is smaller than 24x and unmeasured. `bytes(b64)` is the payload size per frame. (The bench sizes some painters differently from the live pane, e.g. pipeline 136x2; the live-pane sizes are covered by the pairs/size tests.)

### 2.5 root: `npm run typecheck` (repo root, via the temporary junction)
```

> agent-cockpit@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit

exit 0
```

### 2.6 root: `npm test` (vitest, repo root, via the temporary junction)
```

> agent-cockpit@0.1.0 test
> vitest run


 RUN  v3.2.7 C:/Users/pc/.agent-cockpit/worktrees/ebf4b7b4/agent-cockpit/TASK-406

(node:51512) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:46652) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ test/core.test.ts (9 tests) 20ms
 ✓ test/milestone.test.ts (4 tests) 12908ms
   ✓ first vertical milestone > runs the full hierarchy with parallel isolated workers, review correction, integration and approval  4603ms
   ✓ first vertical milestone > REQUEST CHANGES continues the same run with a new planning round  3317ms
   ✓ first vertical milestone > survives an orchestrator restart and resumes from the database  2461ms
   ✓ first vertical milestone > detects an undeclared file overlap at runtime and lets the lead resolve it  2526ms

 Test Files  2 passed (2)
      Tests  13 passed (13)
   Start at  21:16:05
   Duration  13.73s (transform 308ms, setup 0ms, collect 1.07s, tests 12.93s, environment 1ms, prepare 287ms)

exit 0
```

Junction: created with `mklink /J node_modules D:\Claude\agent-cockpit\node_modules`, removed with `rmdir node_modules`; `ls node_modules` afterwards: "No such file or directory"; the target still holds 53 entries. `test/roles.test.ts` does not exist and was not run.

## 3. Blit rate (mock clock, 140 cols, 10 s window after 1 s settle), PROVISIONAL
Baseline before this work: **112 blits/s** (16 fps x 7 rasters), from tests/evidence/BASELINE.md. Measured with a scratch test (not committed; `npm run blitrate` still sets the removed `COCKPIT_CADENCE` and rewrites a tracked file outside my scope, so I did not use it). Fixtures: LIVE (awaiting_approval run plus a running task); the same LIVE with all runs completed and no approvals/workers (no active run); OFFLINE.

| Scenario | total /s | % of 112 | hero | divider | pipeline | progress | spark | orb-w0 | other keys |
|---|---|---|---|---|---|---|---|---|---|
| LIVE, active | **375** | 335% | 62.5 | 62.5 | 62.5 | 62.5 | 62.5 | 62.5 | 0 |
| idle: no active run | 1 | 0.9% | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| idle: offline | 1 | 0.9% | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| idle: reduced motion (LIVE) | 0 | 0% | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Raw:
```
(pass) blitrate live (awaiting_approval + running task) [2249.98ms]
(pass) blitrate idle: no active run (daemon up) [159.01ms]
(pass) blitrate idle: offline (daemon down) [110.39ms]
(pass) blitrate idle: reduced motion on LIVE [144.57ms]
 4 pass
 0 fail
BLIT|{"scenario":"live (awaiting_approval + running task)","env":{},"windowS":10,"totalPerSec":375,"perKeyPerSec":{"hero":62.5,"divider":62.5,"pipeline":62.5,"progress":62.5,"spark":62.5,"orb-w0":62.5}}
BLIT|{"scenario":"idle: no active run (daemon up)","env":{},"windowS":10,"totalPerSec":1,"perKeyPerSec":{"hero":1}}
BLIT|{"scenario":"idle: offline (daemon down)","env":{},"windowS":10,"totalPerSec":1,"perKeyPerSec":{"hero":1}}
BLIT|{"scenario":"idle: reduced motion on LIVE","env":{"COCKPIT_REDUCED_MOTION":"1"},"windowS":10,"totalPerSec":0,"perKeyPerSec":{}}
exit 0
```

Reading it:
- Active: every animated key blits once per 16 ms tick (62.5/s), as the architecture specifies. Only 6 of the 10 rasters blit in the window. `orb-sup` and `orb-lead` are static for this fixture, and `tab-underline` and `meters` are animated only while their tweens are easing (`raster(..., easing(...))` in register.tsx), so once settled they are static and blit 0/s. A fixture that keeps the tweens moving would raise the total, up to 10 keys x 62.5 = 625/s.
- **That is above the 112/s baseline (3.35x total, 3.9x per key) and above the d.ts figure of 120 blits/s taken.** The d.ts says up to 120/s taken, about 60 shown. I cannot tell from here whether that cap is per key or global. If it is global, 6 keys at 62.5/s will largely be dropped or folded by the host, and the delivered rate per key would be well below 60 fps. Proposed constant change if so (not applied; hooks are out of scope): keep hero on the 16 ms tick and move the secondary keys to a slower period (50 ms = 20/s each gives 62.5 + 5 x 20 = 162/s, still over 120; 66 ms = 15/s each gives 137/s), or merge several small rasters into fewer keys. Needs a decision from the Engineering Lead plus a live measurement.
- Idle: at most 2 blits/s total is met (1/s, hero only) for no-run and offline; 0 with reduced motion. Static rasters get 0.
- The mock clock resolves blits instantly, so these are rates the scheduler requests, not frames a terminal displayed.

## 4. Before / after raster dumps (decoded cells)
Files: `tests/evidence/before/live-{60,140}.{txt,json}` (pre-redesign hooks, TASK-401, untouched) and `tests/evidence/after/live-{60,140}.{txt,json}` (produced by `npm run capture` at this HEAD; .txt has t=0, then t=500 and t=1056 ms appended; .json holds t=0 in `rasters` and the rest under `later`). The capture was run twice and the four after files were byte-identical (sha256 below), so the after dumps are reproducible. `npm run capture` also rewrites `before/`; I restored it from HEAD with `git show` (content equal to HEAD; `git status` still shows `M` for those four files only because of CRLF normalisation, and `git diff --stat` for them is empty).

after sha256:
```
cc03d955666d543674f4143a393592a280afa86fa2337b956105b3f41f2a04e6 *tests/evidence/after/live-140.json
08310547c4d79b1d72581adae669e8a527d3d08ffcdba46b8c7dece4c04989ed *tests/evidence/after/live-140.txt
7026a4a918f5a8b00207d7b8560eda334b52e16b97d0d4255f25d9e0375f4606 *tests/evidence/after/live-60.json
645ab48c5ea412eaeafb09f0d58f483fe4c2c687142cb6da91b7530160b00981 *tests/evidence/after/live-60.txt
```

capture output:
```

> @cockpit/claude-plugin@0.1.0 capture
> node --experimental-transform-types --no-warnings scripts/capture.ts

wrote tests/evidence/before/live-60.txt and .json: hero(60x4,215 pairs) pipeline(56x2,17 pairs) progress(50x1,39 pairs) spark(47x1,1 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,4 pairs)
wrote tests/evidence/before/live-140.txt and .json: hero(140x4,470 pairs) pipeline(70x2,20 pairs) progress(64x1,49 pairs) spark(61x1,2 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,4 pairs)
wrote tests/evidence/after/live-60.txt and .json: hero(60x4,111 pairs) divider(58x1,1 pairs) pipeline(56x2,18 pairs) progress(50x1,11 pairs) spark(47x1,1 pairs) tab-underline(56x1,2 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,6 pairs) meters(56x3,22 pairs)
wrote tests/evidence/after/live-140.txt and .json: hero(140x4,179 pairs) divider(72x1,6 pairs) pipeline(70x2,18 pairs) progress(64x1,16 pairs) spark(61x1,2 pairs) tab-underline(70x1,2 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,6 pairs) meters(34x3,20 pairs)
```

### Pair counts (distinct fg/bg pairs per raster at t=0; `before` = committed before dump)
| Raster | before 60 | after 60 | before 140 | after 140 |
|---|---|---|---|---|
| hero (60x4 / 140x4) | 215 | 111 | 458 | 179 |
| pipeline | 17 | 18 | 19 | 18 |
| progress | 39 | 11 | 49 | 16 |
| spark | 1 | 1 | 2 | 2 |
| orb-sup | 3 | 3 | 3 | 3 |
| orb-lead | 3 | 3 | 3 | 3 |
| orb-w0 | 4 | 6 | 4 | 6 |
| divider (new) | - | 1 | - | 6 |
| tab-underline (new) | - | 2 | - | 2 |
| meters (new) | - | 22 | - | 20 |

Raster count: 7 before, 10 after at both widths. New: `divider` (58x1 / 72x1), `tab-underline` (56x1 / 70x1), `meters` (56x3 / 34x3). Hero and orb sizes are unchanged. Hero uses far fewer pairs (458 -> 179 at 140 cols) and every raster is far below the 512 test budget. (A re-run of the old baseline produced hero 470 at 140 cols: the baseline hero depended on wall-clock time, so the before dump is not bit-reproducible; after is.)

### Motion proof (base64 at t=500 and t=1056 vs t=0, from the after .json)
```
cols 60: before hero:60x4 pipeline:56x2 progress:50x1 spark:47x1 orb-sup:4x2 orb-lead:4x2 orb-w0:4x2
cols 60: after  hero:60x4 divider:58x1 pipeline:56x2 progress:50x1 spark:47x1 tab-underline:56x1 orb-sup:4x2 orb-lead:4x2 orb-w0:4x2 meters:56x3
  hero pairs@0=111 t500:differs(pairs 117) t1056:differs(pairs 113)
  divider pairs@0=1 t500:differs(pairs 6) t1056:differs(pairs 6)
  pipeline pairs@0=18 t500:differs(pairs 18) t1056:differs(pairs 17)
  progress pairs@0=11 t500:differs(pairs 13) t1056:differs(pairs 16)
  spark pairs@0=1 t500:same(pairs 1) t1056:same(pairs 1)
  tab-underline pairs@0=2 t500:differs(pairs 6) t1056:same(pairs 2)
  orb-sup pairs@0=3 t500:same(pairs 3) t1056:same(pairs 3)
  orb-lead pairs@0=3 t500:same(pairs 3) t1056:same(pairs 3)
  orb-w0 pairs@0=6 t500:differs(pairs 3) t1056:differs(pairs 6)
  meters pairs@0=22 t500:differs(pairs 21) t1056:differs(pairs 20)
cols 140: before hero:140x4 pipeline:70x2 progress:64x1 spark:61x1 orb-sup:4x2 orb-lead:4x2 orb-w0:4x2
cols 140: after  hero:140x4 divider:72x1 pipeline:70x2 progress:64x1 spark:61x1 tab-underline:70x1 orb-sup:4x2 orb-lead:4x2 orb-w0:4x2 meters:34x3
  hero pairs@0=179 t500:differs(pairs 171) t1056:differs(pairs 181)
  divider pairs@0=6 t500:differs(pairs 6) t1056:differs(pairs 6)
  pipeline pairs@0=18 t500:differs(pairs 18) t1056:differs(pairs 19)
  progress pairs@0=16 t500:differs(pairs 17) t1056:differs(pairs 16)
  spark pairs@0=2 t500:differs(pairs 2) t1056:same(pairs 2)
  tab-underline pairs@0=2 t500:differs(pairs 6) t1056:differs(pairs 3)
  orb-sup pairs@0=3 t500:same(pairs 3) t1056:same(pairs 3)
  orb-lead pairs@0=3 t500:same(pairs 3) t1056:same(pairs 3)
  orb-w0 pairs@0=6 t500:differs(pairs 6) t1056:differs(pairs 6)
  meters pairs@0=20 t500:differs(pairs 21) t1056:differs(pairs 22)
```

Hero, divider, pipeline, progress, orb-w0 and meters change at both later times at both widths, so the animation is time-driven. orb-sup and orb-lead are static for this fixture; spark differs at t=500 only at 140 cols and never at 60. These are harness trees, not a terminal paint.

## 5. Scope proof
```
$ git status --short
 M packages/claude-plugin/tests/evidence/REPORT.md
 M packages/claude-plugin/tests/evidence/after/live-140.json
 M packages/claude-plugin/tests/evidence/after/live-140.txt
 M packages/claude-plugin/tests/evidence/after/live-60.json
 M packages/claude-plugin/tests/evidence/after/live-60.txt
 M packages/claude-plugin/tests/evidence/before/live-140.json
 M packages/claude-plugin/tests/evidence/before/live-140.txt
 M packages/claude-plugin/tests/evidence/before/live-60.json
 M packages/claude-plugin/tests/evidence/before/live-60.txt
$ git diff --stat
 packages/claude-plugin/tests/evidence/REPORT.md    | 478 +++++----------------
 .../tests/evidence/after/live-140.json             |   2 +-
 .../tests/evidence/after/live-140.txt              |  44 +-
 .../tests/evidence/after/live-60.json              |   2 +-
 .../claude-plugin/tests/evidence/after/live-60.txt |  24 +-
 5 files changed, 154 insertions(+), 396 deletions(-)
$ git diff -- . :!packages/claude-plugin | sha256sum
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 *-
bytes: 0
$ git status --short -- . :!packages/claude-plugin   (outside plugin, incl. untracked)
(empty)
$ git diff --exit-code packages/claude-plugin/tests/pane.test.tsx
exit 0
$ git diff --name-only -- packages/claude-plugin/hooks
(empty)
sha256 tests/pane.test.tsx eec875fabcb37ce6009cc222c1cd9b60b2c3c774e9f233f10150f6ced775f4fb
sha256 tests/fixture.ts 4d47f1643c2dda355058491fa6ecbf97e546d310a40c08410146160b9ef620e1
sha256 types/index.d.ts 970568ef0eb1a4d1bb4191aba7ed2e38597af030b87de25d3e0ee12329c511fb
BASELINE.md: pane eec875fabcb37ce6009cc222c1cd9b60b2c3c774e9f233f10150f6ced775f4fb, fixture 4d47f1643c2dda355058491fa6ecbf97e546d310a40c08410146160b9ef620e1, outside-plugin diff e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```


- Outside-plugin diff: `git diff -- . ':!packages/claude-plugin'` is empty (0 bytes), sha256 `e3b0c442...b855` = the value recorded in tests/evidence/BASELINE.md (empty diff, no untracked files outside the plugin). Nothing outside packages/claude-plugin is modified or untracked.
- Changed paths from this run: only `packages/claude-plugin/tests/evidence/after/*` and this `REPORT.md`. `before/*` shows `M` only from CRLF normalisation (no content diff). No file under `hooks/` changed (`git diff --name-only -- packages/claude-plugin/hooks` is empty).
- `git diff --exit-code packages/claude-plugin/tests/pane.test.tsx`: exit 0. sha256 of pane.test.tsx `eec875fa...f4fb` equals BASELINE.md and `baseline/pane.test.sha256`; fixture.ts `4d47f164...20e1` equals BASELINE.md.

## 6. NOT verified in this non-interactive environment (open items)
No terminal or live Claude Code host was available. Do not read any number above as a measured live result.
- **Delivered fps**: how many of the requested blits the host actually shows (the d.ts says about 60/s shown). Unmeasured.
- **Input latency** under a real host. The `PROBE press latency` lines in 2.3 are harness milliseconds with instant blits (p50 6.9 ms, p95 11.1 ms, max 21.4 ms at 140 cols), not live latency.
- **Real CPU** use of the 16 ms loop, the text tick and the painters in the host. The bench is plain Node only.
- **Scope of the 120 blits/s cap**: per key or global? It decides whether the 375/s request in section 3 is acceptable (proposed change there).
- **Blit payload cap**: the largest serialized payload seen is hero at 140 cols, 9013 bytes per blit (`PROBE max serialized blit bytes per key @140`); the per-frame sum over the probe's keys is 14812 bytes. The host's cap is not known here.
- **Colour-pair cap scope** (test budget 512, a 1024 figure appears in older notes): per raster, per frame or per surface is unknown. Max seen: hero 179 pairs at 140 cols.
- **Whether `Date.now` / `performance.now` exist in the production mod host**: the scheduler falls back to `$.clock.now()` re-anchoring (tested with the mock clock only).
- **Real terminal screenshots at 60 and 140 columns**: none. The decoded cell dumps stand in for them.
- **Desktop/mobile surfaces** were exercised only through the test kit (`fallback.test.tsx`, `layout.test.tsx`), not on a real desktop app.
- **Stale artifacts left untouched** (outside my scope): `tests/evidence/blitrate.txt`, `before-bench.txt` and `host-probe.txt` describe earlier code, and `scripts/blitrate.ts` still sets `COCKPIT_CADENCE`. `GATE0.md`, `hooks/limits.ts` and `tests/limits.test.ts` still exist although this revision removed Gate 0 / CADENCE / trace export; they pass but are dead weight for the Lead to decide on.
