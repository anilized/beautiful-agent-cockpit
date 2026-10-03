# TASK-101 evidence: host limits, baseline, interface agreements

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
