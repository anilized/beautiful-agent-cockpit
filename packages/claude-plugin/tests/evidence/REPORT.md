# TASK-307 final validation: root gates, bench, after dumps, blit rate, outside-plugin proof

**Status: validation evidence only. Nothing here is a release.** Release still needs all acceptance criteria green, a Gate 0 report built from an exported live trace (or an explicit per-item human waiver) and a default CADENCE consistent with that evidence. Gate 0 is PENDING on all 7 items (section c). Default `COCKPIT_CADENCE` stays `'conservative'`.

## d. Environment for every number: ALL NUMBERS PROVISIONAL
| Item | Value |
|---|---|
| Node | v22.14.0 (scripts run with `--experimental-transform-types`) |
| OS / CPU | Windows 11 Pro 10.0.26200 (win32/x64), AMD Ryzen 7 7800X3D 8-Core, one dev machine, one run each |
| Engine | Claude Code 2.1.286 (`claude plugin test`) |
| Mock clock | `mock.clock(on)` from `claude-code/testing`; blit-rate window = 10 s after a 1 s settle (not 5 s: `scripts/blitrate.ts` is outside this task's scope; rates are per second so comparable); capture stamps t = 0, 500, 1056 ms; bench uses real `performance.now()`, frame f = f x 16 ms |
| COCKPIT_CADENCE | unset => `conservative`, except the labelled `full` supplemental row |
| COCKPIT_TRACE | unset (off) everywhere, except `COCKPIT_TRACE=1` on the probe run (4.7; a bare Node process records nothing) |
| COCKPIT_REDUCED_MOTION | unset, except the labelled reduced-motion row |
| HEAD | c614142f081b92be3d68a9349e17f7e9e4404431, branch agent/ebf4b7b4/TASK-307-final-validation-root-ga |
| Terminal | none. The `run` skill could not be used to drive a real terminal: this session is non-interactive, there is no tmux and no live terminal, so **no terminal screenshot exists**. The decoded Raster cell dumps are the visual evidence, and they come from the test harness tree, not a terminal paint. |

Typecheck needed `CLAUDE_CODE_DTS` (the plugin-authoring skill's `claude-code.d.ts`; the `.claude/types` copy is gitignored) and `TSC=D:/Claude/agent-cockpit/node_modules/typescript/bin/tsc`. Raw outputs below have ANSI codes and git LF/CRLF warnings stripped, and are otherwise unedited. **Failures: none.** Every command exited 0.

## 1. Numbers
### 1.1 Paint bench at 140 columns (`npm run bench`, raw in 4.4)
| Painter | mean ms | p95 ms | max ms |
|---|---|---|---|
| hero 140x4 | 0.128 | 0.178 | 0.424 |
| divider 72x1 | 0.002 | 0.003 | 0.098 |
| pipeline 70x2 | 0.003 | 0.005 | 0.090 |
| progress 64x1 | 0.004 | 0.005 | 0.119 |
| spark 61x1 | 0.003 | 0.005 | 0.161 |
| underline 70x1 | 0.004 | 0.006 | 0.110 |
| meters 34x3 | 0.003 | 0.004 | 0.080 |
| orb-sup 4x2 | 0.002 | 0.002 | 0.086 |
| orb-lead 4x2 | 0.002 | 0.002 | 0.066 |
| orb-w0 4x2 | 0.002 | 0.002 | 0.083 |
| **COMBINED AFTER (10 rasters)** | **0.153** | **0.211** | **0.447** |
| COMBINED BEFORE (baseline, 7 rasters) | 0.271 | 0.346 | 0.566 |

Budget < 4 ms combined mean: PASS (about 26x margin in plain Node). Inside the `claude plugin test` runtime the assertion test `bench: all live rasters at 140 columns paint in < 4 ms mean per frame` also passes (1.8 s wall for its loop including a JS base64 shim, so the margin there is smaller; the earlier TASK-205 estimate was about 1.2 ms/frame).

### 1.2 Blit rate, LIVE fixture, 140 columns, mock clock (`npm run blitrate`, raw in 4.5)
Baseline before this work: **112 blits/s** (16/s x 7 keys), see BASELINE.md.

| Scenario | total /s | % of 112 | hero | pipeline | meters | divider | progress | spark | underline | orb-sup | orb-lead | orb-w0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| active, conservative (default) | **54** | 48% | 12.8 | 12.8 | 3.6 | 3.6 | 3.5 | 3.5 | 3.5 | 3.5 | 3.6 | 3.6 |
| active, full (supplemental, not default) | 83.4 | 74% | 20.8 | 20.9 | 5.2 | 5.2 | 5.2 | 5.2 | 5.3 | 5.2 | 5.2 | 5.2 |
| offline, conservative | 2 | 2% | 2 | - | - | - | - | - | - | - | - | - |
| active, conservative, reduced motion | 2 | 2% | 2 | - | - | - | - | - | - | - | - | - |

"No active run" idle is covered by test `idle (no active run): <=2 blits/s in total, text tick <=1 fps` (not part of the blitrate script).

**Frames per key, stated honestly.** Under the conservative CADENCE (`totalPerSec` 60, `tierAFps` 30, `tierBFps` 15) no key reaches 60 fps. Tier A keys (hero, pipeline) get about 13 blits/s each and the eight Tier B keys about 3.5/s each; the Tier B cap of 15 is never reached because the 60/s total is shared by 10 keys (and 10% is held back as an urgent reserve). Even the `full` row gives hero/pipeline only about 21/s. The original "about 60 fps" aim is therefore not met under either cadence in the mock harness. Total is 52% below the 112/s baseline, but hero alone is below the old 16/s (12.8 vs 16). The mock clock resolves blits instantly, so these are the rates the scheduler requests, not frames a terminal displayed.

### 1.3 Text tick and idle
Asserted by tests, not measured separately: `live @140 conservative: <=60 blits/s total, Tier A <=30 fps each, text tick <=10 fps`, `idle (offline): <=2 blits/s in total, text tick <=1 fps`, `idle (no active run): <=2 blits/s in total, text tick <=1 fps`.

## 2. Before/after visuals
- `tests/evidence/before/live-60.{txt,json}`, `live-140.{txt,json}`: pre-redesign dumps (TASK-205), unchanged. The `before` capture is **not reproducible bit-for-bit**: the baseline hero depends on the wall clock, so re-running `npm run capture` changed hero colours (458 vs 470 colour pairs at 140 cols). The script rewrites `before/`; I restored the committed copies with `git show HEAD:...`, so the content equals HEAD. "Same mock t=0" therefore holds for the AFTER side only.
- `tests/evidence/after/live-60.{txt,json}`, `live-140.{txt,json}`: AFTER at mock t=0 first, then t=500 ms and t=1056 ms appended (the `.json` keeps t=0 in `rasters` and the others under `later[{t, rasters}]`). 10 rasters per timestamp: hero, divider, pipeline, progress, spark, underline, orb-sup, orb-lead, orb-w0, meters.
- Motion proof (base64 payload compared with t=0, from the .json): at 140 cols hero, divider, pipeline, progress, underline, orb-w0 and meters differ at both t=500 and t=1056; spark differs at 500 only; orb-sup and orb-lead are identical (static for this fixture). At 60 cols the same, except spark is identical and underline differs at 500 only.
- Colour pairs at t=0, 140 cols: hero 177, all others <= 20; 60 cols: hero 111, others <= 22. All far below the 512 test budget and the 1024 host figure.
- Not a terminal screenshot: see section d.

## 3. Capture tooling
`tests/capture.ts` (extends the TASK-205 harness dump; a `claude plugin test` scratch test, since tests have no fs): mounts the pane on the terminal surface at 60 and 140 columns under `mock.clock`, stubs `ui.blit`, and prints a decoded dump at STAMPS = [0, 500, 1056]. `scripts/capture.ts` needed a small change (listed under leaseRequests): it parses t=0 as the primary dump and appends the later stamps for `after` only.

## 4. Verbatim output
### 4.1 plugin: npm run typecheck
```text
> @cockpit/claude-plugin@0.1.0 typecheck
> node tests/tools.mjs typecheck
exit 0
```
### 4.2 plugin: npm run palette
```text
> @cockpit/claude-plugin@0.1.0 palette
> node tests/tools.mjs palette
exit 0
```
### 4.3 plugin: npm run test (palette + `claude plugin test .`): 69 pass, 0 fail
```text
> @cockpit/claude-plugin@0.1.0 test
> node tests/tools.mjs palette && claude plugin test .

PROBE rasters@60 = {"count":10,"keys":["hero:60x4","divider:58x1","pipeline:56x2","progress:50x1","spark:47x1","underline:56x1","orb-sup:4x2","orb-lead:4x2","orb-w0:4x2","meters:56x3"]}
PROBE max serialized blit bytes per key @60 = {"perKey":{"hero":3893,"pipeline":1849,"divider":984,"progress":857,"spark":806,"underline":954,"orb-sup":184,"orb-lead":185,"orb-w0":183,"meters":2743},"worstKey":3893,"perFrameSum":12638}
PROBE 1s mock, instant blits @60 = {"blitsPerSec":53,"perKey":{"hero":12,"pipeline":12,"divider":4,"progress":4,"spark":4,"underline":4,"orb-sup":4,"orb-lead":3,"orb-w0":3,"meters":3},"maxInflight":1,"harnessElapsedMsFor1s":180.3}
PROBE press latency ms @60 (instant blits) = {"p50":9.08,"p95":17.8,"max":28.31}
PROBE slow host (500ms/blit) 1s @60 = {"started":20,"maxInflight":10,"inflightAtEnd":10}
PROBE press with 10 blits pending @60 (harness ms) = 9.26
PROBE rasters@140 = {"count":10,"keys":["hero:140x4","divider:72x1","pipeline:70x2","progress:64x1","spark:61x1","underline:70x1","orb-sup:4x2","orb-lead:4x2","orb-w0:4x2","meters:34x3"]}
PROBE max serialized blit bytes per key @140 = {"perKey":{"hero":9013,"pipeline":2297,"divider":1208,"progress":1081,"spark":1030,"underline":1178,"orb-sup":184,"orb-lead":185,"orb-w0":183,"meters":1687},"worstKey":9013,"perFrameSum":18046}
PROBE 1s mock, instant blits @140 = {"blitsPerSec":53,"perKey":{"hero":12,"pipeline":12,"divider":4,"progress":4,"spark":4,"underline":4,"orb-sup":4,"orb-lead":3,"orb-w0":3,"meters":3},"maxInflight":1,"harnessElapsedMsFor1s":115}
PROBE press latency ms @140 (instant blits) = {"p50":5.29,"p95":7.67,"max":16.16}

tests\bench.test.ts:
(pass) bench: all live rasters at 140 columns paint in < 4 ms mean per frame [1800.68ms]
PROBE slow host (500ms/blit) 1s @140 = {"started":20,"maxInflight":10,"inflightAtEnd":10}
PROBE press with 10 blits pending @140 (harness ms) = 6.9
PROBE hero blits during 500ms with deny, then 500ms accepting = {"duringDeny":1,"total":1,"note":"a deny drops the key, but the next 125 ms text render re-registers it: stale-deny guard needed"}
PROBE blits in 500ms after ui.unmount (all denied only by a real host) = {"blits":27,"uiCloseEvents":[]}
PROBE blits in 500ms after session.end = 0

tests\fallback.test.tsx:
(pass) hotkeys s n a c r e i 1 2 3 j k p t x each stay bound to their action [707.18ms]
(pass) text fallbacks stay within bodyColumns (terminal): ▔ underline, ▕ meters, divider rule [169.58ms]
(pass) text fallbacks stay within bodyColumns (desktop): ▔ underline, ▕ meters, divider rule [123.33ms]
(pass) desktop: no raster, no blits, hero and telemetry as text [205.17ms]
(pass) a blit the host denies unregisters its key and is not hammered; a never-resolving blit is skipped [3164.55ms]
(pass) a late deny after session.end has no effect (no blits, no throw) [213.78ms]
(pass) session.end silences a live scheduler, a later render is inert, session.start re-enables [533.24ms]
(pass) trace off: no file and no output from session.end or the command [200.47ms]
(pass) trace on: nothing is written while running; session.end exports chronological ring buffers; the command returns the dump [1917.61ms]

tests\host-probe.test.tsx:
(pass) blit cadence, backpressure and latency @60 cols (current code) [673.03ms]
(pass) unresolved blits pile up @60 cols (current code has no backpressure) [724.20ms]
(pass) blit cadence, backpressure and latency @140 cols (current code) [308.85ms]
(pass) unresolved blits pile up @140 cols (current code has no backpressure) [600.21ms]
(pass) deny semantics: current code unregisters on any deny, stale or not [166.46ms]
(pass) lifecycle: what the plugin hears when the drawing or session goes away (current code) [108.37ms]

tests\layout.test.tsx:
(pass) width() counts wide characters as two cells [3.21ms]
(pass) no Text line exceeds bodyColumns: live, terminal and desktop, 60/100/140 [531.80ms]
(pass) no Text line exceeds bodyColumns: offline, terminal and desktop, 60/100/140 [183.27ms]

tests\limits.test.ts:
(pass) resolveCadence: unset, invalid and valid values [4.27ms]
(pass) readGates: all off by default, read once through the injected accessor [1.16ms]
(pass) trace off: no recording, no export, no file, no output [0.77ms]
(pass) export round-trip: mock host events over several keys, ring wrap keeps chronological order [1.71ms]
(pass) writeTrace without a data-dir write API returns the serialized dump [0.39ms]
(pass) HOST_LIMITS: exactly 7 tagged fields, each with a cite or none [3.29ms]

tests\motion.test.tsx:
(pass) live @140 conservative: <=60 blits/s total, Tier A <=30 fps each, text tick <=10 fps [1175.07ms]
(pass) a host that never resolves: at most one blit in flight per key [2386.85ms]
(pass) zero blits after session.end [146.40ms]
(pass) a key that leaves the render is not blitted from the next tick [194.13ms]
(pass) idle (offline): <=2 blits/s in total, text tick <=1 fps [277.60ms]
(pass) idle (no active run): <=2 blits/s in total, text tick <=1 fps [351.43ms]
(pass) COCKPIT_REDUCED_MOTION=1: animation time frozen, status changes still render [179.03ms]
(pass) progress eases between snapshots of one run, snaps on a run switch [533.52ms]
(pass) tweens snap on remount (no host unmount event: a render gap past the idle beat resets them) [269.29ms]

tests\pane.test.tsx:
(pass) pane draws offline at every width [287.07ms]
(pass) pane draws live at every width [579.74ms]
(pass) a refused launch shows a failure card with the fix [117.00ms]

tests\raster.test.ts:
(pass) every painter returns exactly cols*rows*12 bytes at every width, deterministically [82.18ms]
(pass) orb paints any size, including 1x1 and 8x4 [0.75ms]
(pass) pairCount counts distinct fg/bg pairs [2.32ms]
(pass) frame-rate independence: 16 ms and 33 ms clocks give identical frames at shared instants [667.79ms]
(pass) animation depends on time: moving painters differ across a second, static ones do not [3.88ms]
(pass) <=512 distinct fg/bg pairs per frame at 140 columns [26.79ms]
(pass) hero stays <=512 pairs over 200 timestamps, alert on/off, 4 and 6 rows [974.52ms]
(pass) pipeline: integer phase drives glyphs, fractional fill only paints the connector [0.67ms]
(pass) perf guard: all live painters at 140 columns stay well under the 4 ms budget (loose; tests/bench.ts is the real number) [353.76ms]

tests\scheduler.test.ts:
(pass) (a) never-resolving host: in-flight <=1 per key over 5 s, skipped not queued [11.19ms]
(pass) deny still unregisters the key [0.87ms]
(pass) (b) zero blits after close and after end [1.99ms]
(pass) (c) dropped key is not blitted from the next tick [3.56ms]
(pass) (d) timer stops when there are no live keys [0.62ms]
(pass) (e) 140-col live set for 10 s: <=60 blits/s total, Tier A <=30 fps, far below 112 [17.84ms]
(pass) (f) watchdog: refused period kills the interval, re-arm, late old-gen resolve does not clear the new slot [1.42ms]
(pass) (g) stale deny does not unregister the replacement [0.67ms]
(pass) (h) degrade halves Tier A and restores after 2 s healthy [1.52ms]
(pass) (i) idle: total <=2/s, hero only, back to frame rate on motion [0.89ms]
(pass) deny unregisters even after an unrelated generation bump [0.38ms]
(pass) a stalled blit keeps its slot: no second blit until it resolves [2.20ms]
(pass) burst cap: throughput near the refill rate at 16 ms and in idle at 500 ms [7.17ms]
(pass) makeSyncClock: sync reads, one prefetch in flight, local source advances [0.64ms]
(pass) panes() polling: <=1 Hz, only idle or degraded, never while healthy and moving [2.34ms]
(pass) urgent repaint uses the reserve and still respects one pending slot [0.83ms]

tests\tween.test.ts:
(pass) endpoints and monotonic easing [5.53ms]
(pass) retarget starts from the sampled value, not the old target [0.89ms]
(pass) per-channel colour: red -> blue midpoint [4.54ms]
(pass) run-id isolation, run switch snap, reset, motion off snap [0.96ms]
(pass) settled / idle detection [1.10ms]
(pass) easing is monotonic over a dense sweep [42.06ms]
(pass) discrete phase stays integer while fill interpolates [1.14ms]

 69 pass
 0 fail
Ran 69 tests across 10 files. [7.49s]
exit 0
```
### 4.4 plugin: npm run bench
```text
> @cockpit/claude-plugin@0.1.0 bench
> node --experimental-transform-types --no-warnings --import ./tests/resolve-ts.mjs scripts/bench.ts

bench: node v22.14.0, win32/x64, BENCH_N=2000

AFTER (hooks/raster.ts): 2000 frames after 300 warm-up, 140 columns
painter           mean ms   p95 ms   max ms  bytes(b64)
hero 140x4         0.128    0.178    0.424  8960
divider 72x1       0.002    0.003    0.098  1152
pipeline 70x2      0.003    0.005    0.090  2240
progress 64x1      0.004    0.005    0.119  1024
spark 61x1         0.003    0.005    0.161  976
underline 70x1     0.004    0.006    0.110  1120
meters 34x3        0.003    0.004    0.080  1632
orb-sup 4x2        0.002    0.002    0.086  128
orb-lead 4x2       0.002    0.002    0.066  128
orb-w0 4x2         0.002    0.002    0.083  128
COMBINED           0.153    0.211    0.447  (budget: mean < 4 ms) PASS

BEFORE (baseline raster, frame-counter API): 2000 frames after 300 warm-up, 140 columns
painter           mean ms   p95 ms   max ms  bytes(b64)
hero 140x4         0.239    0.307    0.523  8960
pipeline 70x2      0.009    0.013    0.327  2240
progress 64x1      0.007    0.009    0.131  1024
spark 61x1         0.007    0.010    0.141  976
orb-sup 4x2        0.004    0.005    0.213  128
orb-lead 4x2       0.002    0.003    0.119  128
orb-w0 4x2         0.002    0.003    0.133  128
COMBINED           0.271    0.346    0.566  (budget: mean < 4 ms) PASS

before combined mean 0.271 ms (7 rasters) vs after 0.153 ms (10 rasters)
exit 0
```
### 4.5 plugin: npm run blitrate
```text
> @cockpit/claude-plugin@0.1.0 blitrate
> node --experimental-transform-types --no-warnings scripts/blitrate.ts

blit-rate: mock clock, 10 s window after 1 s settle, 140 columns, baseline before this work = 112 blits/s (16/s x 7 keys)
live {"COCKPIT_CADENCE":"conservative"}: total 54/s (48% of 112) per key {"orb-lead":3.6,"hero":12.8,"orb-w0":3.6,"pipeline":12.8,"meters":3.6,"divider":3.6,"progress":3.5,"spark":3.5,"underline":3.5,"orb-sup":3.5}
live {"COCKPIT_CADENCE":"full"}: total 83.4/s (74% of 112) per key {"pipeline":20.9,"underline":5.3,"orb-sup":5.2,"hero":20.8,"orb-lead":5.2,"orb-w0":5.2,"meters":5.2,"divider":5.2,"progress":5.2,"spark":5.2}
offline {"COCKPIT_CADENCE":"conservative"}: total 2/s (2% of 112) per key {"hero":2}
live {"COCKPIT_CADENCE":"conservative","COCKPIT_REDUCED_MOTION":"1"}: total 2/s (2% of 112) per key {"hero":2}
exit 0
```
### 4.6 plugin: npm run capture
```text
> @cockpit/claude-plugin@0.1.0 capture
> node --experimental-transform-types --no-warnings scripts/capture.ts

wrote tests/evidence/before/live-60.txt and .json: hero(60x4,215 pairs) pipeline(56x2,17 pairs) progress(50x1,39 pairs) spark(47x1,1 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,4 pairs)
wrote tests/evidence/before/live-140.txt and .json: hero(140x4,470 pairs) pipeline(70x2,20 pairs) progress(64x1,49 pairs) spark(61x1,2 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,4 pairs)
wrote tests/evidence/after/live-60.txt and .json: hero(60x4,111 pairs) divider(58x1,1 pairs) pipeline(56x2,18 pairs) progress(50x1,11 pairs) spark(47x1,1 pairs) underline(56x1,2 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,6 pairs) meters(56x3,22 pairs)
wrote tests/evidence/after/live-140.txt and .json: hero(140x4,177 pairs) divider(72x1,6 pairs) pipeline(70x2,18 pairs) progress(64x1,15 pairs) spark(61x1,2 pairs) underline(70x1,2 pairs) orb-sup(4x2,3 pairs) orb-lead(4x2,3 pairs) orb-w0(4x2,6 pairs) meters(34x3,20 pairs)
exit 0
```
### 4.7 plugin: COCKPIT_TRACE=1 npm run probe
`COCKPIT_TRACE` is read through the host accessor `$.env.get` (d.ts:3360-3370) inside the mod host. A bare Node probe records no host events, so it prints HOST_LIMITS and CADENCE and "no trace supplied": **it cannot substitute for a live trace** and moves no Gate 0 item off pending.
```text
> @cockpit/claude-plugin@0.1.0 probe
> node --experimental-transform-types --no-warnings scripts/probe.ts

## HOST_LIMITS
- blitRateCap: 120 [default] d.ts:2178-2180 (per second; scope assumed per plugin)
- framesShownPerSec: 60 [documented] d.ts:2178-2180
- payloadCapBytes: null [unverified] none (cols*rows*3 words contract binding)
- colorPairCap: 1024 [unverified] d.ts:8429 (scope unverified)
- clockMinPeriodMs: 1 [documented] d.ts:3228-3231 (a refused period ends the interval)
- panesCostMs: null [unverified] d.ts:2308-2319 (cost unstated)
- realTerminalFps: 30 [unverified] none (target, >=30)

## CADENCE conservative
{"totalPerSec":60,"tierAFps":30,"tierBFps":15,"urgentReserve":0.1,"framePeriodMs":16,"idlePeriodMs":500}

no trace supplied (usage: npm run probe -- <trace.json>)
exit 0
```
### 4.8 root: npm run typecheck
```text
> agent-cockpit@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
exit 0
```
### 4.9 root: npm test (vitest)
Run through a TEMPORARY junction `node_modules` -> `D:\Claude\agent-cockpit\node_modules` (mklink /J), removed with `rmdir`; `ls node_modules` fails afterwards and the target still holds its 53 entries. Plugin-local runs were not used for this gate.
```text
> agent-cockpit@0.1.0 test
> vitest run


 RUN  v3.2.7 C:/Users/pc/.agent-cockpit/worktrees/ebf4b7b4/agent-cockpit/TASK-307

(node:47216) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:49268) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ test/core.test.ts (9 tests) 17ms
 ✓ test/milestone.test.ts (4 tests) 11967ms
   ✓ first vertical milestone > runs the full hierarchy with parallel isolated workers, review correction, integration and approval  4108ms
   ✓ first vertical milestone > REQUEST CHANGES continues the same run with a new planning round  3108ms
   ✓ first vertical milestone > survives an orchestrator restart and resumes from the database  2234ms
   ✓ first vertical milestone > detects an undeclared file overlap at runtime and lets the lead resolve it  2515ms

 Test Files  2 passed (2)
      Tests  13 passed (13)
   Start at  20:28:54
   Duration  12.70s (transform 246ms, setup 0ms, collect 975ms, tests 11.98s, environment 0ms, prepare 250ms)
exit 0
```

## a. Criteria-to-proof table
Test names are from the `claude plugin test .` run in 4.3 (all `(pass)`).

| # | Acceptance criterion | Proof |
|---|---|---|
| 1 | Frame-rate independence (time-based painters) | `raster.test.ts`: "frame-rate independence: 16 ms and 33 ms clocks give identical frames at shared instants"; "animation depends on time: moving painters differ across a second, static ones do not" |
| 2 | Backpressure: at most one blit in flight per key, no unbounded queue | `scheduler.test.ts`: "(a) never-resolving host: in-flight <=1 per key over 5 s, skipped not queued", "a stalled blit keeps its slot: no second blit until it resolves"; `motion.test.tsx`: "a host that never resolves: at most one blit in flight per key"; `fallback.test.tsx`: "a blit the host denies unregisters its key and is not hammered; a never-resolving blit is skipped" |
| 3 | Deny handling | `scheduler.test.ts`: "deny still unregisters the key", "(g) stale deny does not unregister the replacement", "deny unregisters even after an unrelated generation bump"; `fallback.test.tsx`: "a late deny after session.end has no effect" |
| 4 | Idle / offline / reduced-motion rates (blit <= 2/s, text tick <= 1 fps) | `motion.test.tsx`: "idle (offline)...", "idle (no active run)...", "COCKPIT_REDUCED_MOTION=1: animation time frozen, status changes still render"; `scheduler.test.ts`: "(i) idle: total <=2/s, hero only, back to frame rate on motion"; measured 2/s rows in 1.2 |
| 5 | Tweens ease toward targets | `tween.test.ts` (7 tests: endpoints, retarget, per-channel colour, run-id isolation, settled detection, dense monotonic sweep, discrete phase); `motion.test.tsx`: "progress eases between snapshots of one run, snaps on a run switch", "tweens snap on remount ..." |
| 6 | Single theme/tokens + palette check | `npm run palette` (4.2, also run first by `npm test`): hex literals only in `hooks/theme.ts`; `theme.ts`, `raster.ts`, `register.tsx` must exist. The seeded-failure demonstration is in TASK-301's BASELINE.md |
| 7 | New rasters with text fallbacks | `fallback.test.tsx`: "text fallbacks stay within bodyColumns (terminal): underline, meters, divider rule", "(desktop)...", "desktop: no raster, no blits, hero and telemetry as text"; `layout.test.tsx` (60/100/140, live and offline, terminal and desktop) |
| 8 | Painter size and determinism | `raster.test.ts`: "every painter returns exactly cols*rows*12 bytes at every width, deterministically", "orb paints any size, including 1x1 and 8x4", "<=512 distinct fg/bg pairs per frame at 140 columns", "hero stays <=512 pairs over 200 timestamps ...", "pipeline: integer phase drives glyphs ..." |
| 9 | Benchmark < 4 ms combined at 140 cols | `bench.test.ts` "bench: all live rasters at 140 columns paint in < 4 ms mean per frame"; `raster.test.ts` "perf guard ..."; numbers in 1.1 (combined mean 0.153 ms) |
| 10 | `tests/pane.test.tsx` unchanged | section b: sha256 eec875fa... equals BASELINE.md; `git diff --quiet HEAD -- tests/pane.test.tsx` exit 0; its 3 tests pass in 4.3 |
| 11 | Hotkeys and interaction keys preserved | `fallback.test.tsx`: "hotkeys s n a c r e i 1 2 3 j k p t x each stay bound to their action"; `pane.test.tsx` (button keys, failure card) |
| 12 | Root gates | 4.8 and 4.9 (both exit 0, tsc clean, vitest 13/13) |
| 13 | Reduced motion | `motion.test.tsx` reduced-motion test above; blit-rate row (2/s) in 1.2 |
| 14 | Before/after visuals | section 2: `tests/evidence/before/*`, `tests/evidence/after/*` (cell dumps at 60/140, t=0/500/1056); harness decode, no terminal screenshot |
| 15 | Export round-trip (ring wrap order preserved) | `limits.test.ts`: "export round-trip: mock host events over several keys, ring wrap keeps chronological order", "writeTrace without a data-dir write API returns the serialized dump"; `fallback.test.tsx`: "trace on: nothing is written while running; session.end exports chronological ring buffers; the command returns the dump" |
| 16 | Trace off: no file, no output | `limits.test.ts`: "trace off: no recording, no export, no file, no output", "readGates: all off by default, read once through the injected accessor"; `fallback.test.tsx`: "trace off: no file and no output from session.end or the command" |
| 17 | Lifecycle (no blits after close/end) | `scheduler.test.ts` "(b) zero blits after close and after end"; `motion.test.tsx` "zero blits after session.end"; `fallback.test.tsx` "session.end silences a live scheduler ..." |
| 18 | Blit rate vs the 112/s baseline | 1.2 (54/s conservative); `motion.test.tsx` "live @140 conservative: <=60 blits/s ..."; `scheduler.test.ts` "(e) 140-col live set for 10 s ..." |

Gap in proof: the `ui.close` export trigger has no test (TASK-306 removed its two tests because the test kit has no `$.ui.close`); `session.end` covers the same close/export path.

## b. Outside-plugin proof
Compared with `tests/evidence/BASELINE.md` (HEAD 66712d4 there; empty outside-plugin diff).
```text
$ git diff -- . ':!packages/claude-plugin' | sha256sum
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 *-
$ git diff --name-only -- . ':!packages/claude-plugin' | wc -l
0
$ git ls-files --others --exclude-standard -- . ':!packages/claude-plugin' | wc -l
0
$ git status --short -- . ':!packages/claude-plugin'
(empty)
```
BASELINE.md records the same: sha256 e3b0c442...b855 (empty input), no files, no untracked files. **Identical.** The temporary root `node_modules` junction was removed before this check was final.

Hashes (BASELINE.md vs now, from `node tests/tools.mjs sha`):
| File | BASELINE.md | Now | Equal |
|---|---|---|---|
| tests/pane.test.tsx | eec875fabcb37ce6009cc222c1cd9b60b2c3c774e9f233f10150f6ced775f4fb | eec875fabcb37ce6009cc222c1cd9b60b2c3c774e9f233f10150f6ced775f4fb | yes |
| tests/fixture.ts | 4d47f1643c2dda355058491fa6ecbf97e546d310a40c08410146160b9ef620e1 | 4d47f1643c2dda355058491fa6ecbf97e546d310a40c08410146160b9ef620e1 | yes |
| types/index.d.ts | 970568ef0eb1a4d1bb4191aba7ed2e38597af030b87de25d3e0ee12329c511fb | 970568ef0eb1a4d1bb4191aba7ed2e38597af030b87de25d3e0ee12329c511fb | yes |

`git diff --stat -- packages/claude-plugin` (uncommitted work of this task only, taken before REPORT.md was written; earlier tasks are already commits on the branch):
```text
 packages/claude-plugin/scripts/capture.ts          |  11 +-
 packages/claude-plugin/tests/capture.ts            |  25 ++-
 .../tests/evidence/after/live-140.json             |   2 +-
 .../tests/evidence/after/live-140.txt              | 226 +++++++++++++++++----
 .../tests/evidence/after/live-60.json              |   2 +-
 .../claude-plugin/tests/evidence/after/live-60.txt | 198 ++++++++++++++++--
 6 files changed, 396 insertions(+), 68 deletions(-)
```
Earlier out-of-plugin modifications: the dirty state the original brief described (modified paths predating the run, untracked `test/roles.test.ts`) does not exist in this checkout, as BASELINE.md already records. There was nothing to revert and nothing was reverted. `tests/evidence/before/*` may show as modified in `git status` through line-ending normalisation only; its content equals HEAD.

## c. Gate 0 report (all PENDING; from `GATE0.md` and `hooks/limits.ts`)
The human approved live validation but waived no item by name. Nothing is waived and nothing is approved for release. No exported live trace exists, so no item has host evidence.

| # | Item (HOST_LIMITS field) | Assumed value | Status |
|---|---|---|---|
| 1 | Blit-rate cap and scope (`blitRateCap`) | 120/s, scope per plugin assumed (tag `default`) | pending |
| 2 | Frames shown per second (`framesShownPerSec`) | about 60 (tag `documented`, d.ts:2178-2180) | pending |
| 3 | Payload cap (`payloadCapBytes`) | none known; cols*rows*3 words contract stays binding (`unverified`) | pending |
| 4 | Colour-pair cap (`colorPairCap`) | 1024, scope (raster, pane or terminal) unverified | pending |
| 5 | Clock minimum period (`clockMinPeriodMs`) | 1 ms (`documented`, d.ts:3228-3231) | pending |
| 6 | `$.ui.panes()` cost (`panesCostMs`) | unknown; poll ceiling 1 Hz | pending |
| 7 | >= 30 fps on the real terminal (`realTerminalFps`) | 30 as a target, achievability unknown | pending |

Harness-only numbers (SUPPLEMENTAL, PROVISIONAL, not live host measurements): bench ms (1.1), mock-clock blit rates (1.2), serialized blit sizes from the `PROBE` lines in 4.3 (hero 9013 bytes at 140 cols, per-frame sum 18046; the cap itself is unknown), colour-pair counts (<= 177 per raster), mock-clock timer periods. **NOT measured:** delivered fps, input latency, real CPU, real 60/140-column layout in a terminal, blit-limit scope (per key, plugin or pane), colour-pair scope, `panes()` cost. The `PROBE press latency` figures in 4.3 are harness-clock ms, not input latency. Default CADENCE `'conservative'` is unchanged and nothing here justifies changing it.

## e. Open issues and constraints
1. **Per-key frame rate is below the goal.** Conservative: hero/pipeline about 12.8/s, the other keys about 3.5/s (1.2). About 60 fps is not reachable for any key with 10 keys sharing 60/s, and hero is below the old 16/s. Proposed constant change, to be taken only after Gate 0 items 1, 2 and 7 have live data: raise `CADENCE.conservative.totalPerSec` (60) toward the measured delivered limit, and/or lower `tierBFps` (15) to about 4 so the budget is explicit and the freed share goes to hero/pipeline. No constant was changed here.
2. **Window length.** The blit-rate window is 10 s, not 5 s (script out of scope); rates are per second.
3. **`before` dumps are not reproducible** (baseline hero depends on the wall clock), so the before/after t=0 pair is not strictly "same mock t=0" for hero.
4. **No `ui.close` test** (see the gap under a).
5. **A probe without a live trace is empty** (4.7). A live `/cockpit trace` export with `COCKPIT_TRACE=1` inside Claude Code is still required for items 1 to 7.
6. **No real terminal evidence** (non-interactive session, no tmux).
7. `scripts/capture.ts` was modified (outside the owned file list) to append the later timestamps; see leaseRequests.
8. `tests/evidence/blitrate.txt` was regenerated by `npm run blitrate`; its content equals HEAD.
