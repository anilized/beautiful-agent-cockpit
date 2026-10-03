# TASK-101 evidence: host limits, baseline, interface agreements

Engine: Claude Code 2.1.286. Declarations: `claude-code.d.ts` written by the plugin-authoring skill (cited as `d.ts:<line>`).
Each fact is tagged **[doc]** (declared), **[measured]** (probe in this repo, mock clock) or **[open]**.

## 1. Tooling (verified)
- `plugin-authoring` loaded via Skill. `run` skill not loaded: capture needs no running app (see below). Hot reload is off in this session (non-interactive); irrelevant to tests.
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
| Blit limit scope | **[doc]** d.ts:2178: "blits between frames fold into one: up to 120 a second taken, some sixty shown". Not stated whether shared across keys/rasters/plugins. **[open]** cannot be measured here (see 4). Plan on a shared budget. |
| Blit payload | **[doc]** `cells` = base64 of cols*rows u32 triplets, must be the mounted size; deny on wrong size, undecodable cells, unmounted, another plugin's. No byte cap declared. Raster 1..512 cols, 1..256 rows (d.ts:8440). Current largest: hero 140x4 = 8960 b64 chars. |
| Colour pairs | **[doc]** d.ts:8429: palette paints 1024 distinct pairs at once, the rest as nearest. Scope (per Raster, per frame, per terminal) not stated. **[open]**. Baseline live @140: hero 458 + pipeline 19 + progress 49 + spark 2 + orbs 10 = 538 (per-raster counts are unions only if no pair repeats; the true distinct total is <= this). Offline @140 hero alone 488. Already over the 512 target; quantization is required. |
| Blit result | `{}` or `{ deny }`; deny reasons: not mounted, size mismatch, bad cells. Resize is a redraw (`$.ui.invalidate("ui.render")`), not a blit. |
| Invalidate | **[doc]** redraw at most 10/s, 30/s for the shown pane (folds). |
| Test APIs | `mock.clock(on)` -> `{now, advance, set, settle, sleep}`; `mock.env`, `mock.store`; mount handle `drawn/find/findAll/press/input/advance/resize/redraw/unmount`; `on('ui.blit')` beneath the plugin intercepts blits (count, delay, deny); `find({type:'Raster'}).props.cells` exposes cells. `ui.advance` moves only a `Client`'s frame clock, not plugin `$.clock` timers. |

## 3. Baseline (current code, mock clock)
Raster keys: hero, pipeline, progress, spark, orb-sup, orb-lead, orb-w0 (7). Sizes @60: 60x4, 56x2, 50x1, 47x1, 4x2 x3. @140: 140x4, 70x2, 64x1, 61x1, 4x2 x3.
- Cadence: 16 blits/s/key = 112/s total, all unconditionally, even if idle-looking. Close to the 120/s ceiling; leaves no room for any other blit.
- Backpressure: with a host that takes 500 ms per blit, 112 blits started in 1 s, **63 concurrent in flight**, 56 pending at end (unbounded queue).
- Deny: the first deny drops the key, but the next text re-render (125 ms tick while moving) re-registers it, so a late deny from a previous size/run can drop a fresh registration (no generation guard).
- Input latency: harness wall time per `ui.press` 4.5 ms p50 / 6.5 ms p95 (7.4-11.6 ms with 56 blits pending). This is mod+harness CPU, not terminal key-to-photon latency.
- CPU: 1 s of animation at 112 blits cost ~92-106 ms of harness time (mod paint + encode + mocks).
- Paint cost (`before-bench.txt`): combined mean 0.27 ms, p95 0.34 ms at 140 cols (hero 0.23 ms). Budget is 4 ms, so there is large headroom; the real constraints are blit rate and pair count.
- Cell/tree dumps: `before-60.txt`, `before-140.txt` (live and offline, mock t=0).

## 4. Not measurable here (escalated, not invented)
Delivered cadence, folding, and whether 120/s is shared need a real interactive terminal session: this session is non-interactive and the test kit never paints. Supervisor decision needed or a manual run: mount the pane, run `claude --debug`, and count frames with N keys blitting at 16 ms. Until then the scheduler must assume: shared budget <= 100 blits/s, ~60 shown, pair limit per frame across all Rasters of the pane.

## 5. Interface agreements (for scheduler/painter/tween workers)

### Time
- `type Now = () => number` returns monotonic animation ms. Host default `performance.now()`. Tests cannot inject into the plugin env directly, and `performance.now` ignores `mock.clock`, so: the plugin reads `$.env.get('COCKPIT_ANIM_CLOCK')`; `'wall'` makes the scheduler derive `t` from `await $.clock.now()` each tick (mock-controlled), otherwise `performance.now()`. Tests set it with `mock.env`. pane.test.tsx sets nothing and gets perf time.
- Wall time (`$.clock.now()`) stays for timestamps/labels only.
- Reduced motion (`COCKPIT_REDUCED_MOTION=1`, read in `locate`): ambient `t` is a constant (0); tweens snap.

### Painters (raster.ts, pure, no module state)
- `fn(…size, t: number /*ms*/, data): string` (base64, exactly cols*rows*3 u32). Speeds in rad/s or cells/s, never per frame.
- Examples: `hero(cols, rows, t, info)`, `pipeline(cols, t, info)`, `progress(cols, t, fill, live)`, `spark(cols, rows, t, values, live)`, `orb(t, color, active, seed)`. New: `divider(cols, t)`, `tabs(cols, t, data)`, `telemetry(cols, rows, t, data)`.
- Callers pass already-interpolated values (`fill`, `values`, colours); painters never read tween state.
- Write `Uint32Array` words directly; no per-cell arrays. Colours come only from `theme.ts`; gradients quantized to ~32 levels; <=512 distinct fg/bg pairs across all rasters per frame.
- Bench (`tests/bench.ts`) will switch from `f` to `t = f*60` when painters change; keep export names so it needs one edit.

### Pipeline
- `PipelineInfo = { steps: string[]; phase: number /*discrete: label + active node + failure semantics*/; fill: number /*interpolated 0..steps.length-1, display only*/; failed: boolean; color: number }`. The active node is drawn from `phase`, never from `fill`, so it stays visible mid-transition.

### Tween store (tween.ts)
- `type Tween = { from: number|number[]; to: number|number[]; startMs: number; durMs: number }`; key = `runId + ':' + element`. `sample(key, target, t, opts): value` creates/retargets (new `from` = value sampled at `t`), ease-out cubic, 400-700 ms. Colours interpolate per RGB channel. `snap(key|prefix)` for run switch (user-initiated), unmount, idle, reduced motion. Pure given `(store, t)`; the store is a module-level object owned by the caller (register.tsx), not raster.ts.

### Scheduler (scheduler.ts, module-level, survives re-render)
- `register(key, { cols, rows, tier: 'A'|'B'|'static', paint: (t) => string })` reconciles by key; `gen` increments on a new key, size change, run switch or remount.
- `pending: Set<key>` outside the render-rebuilt map; a key with a pending blit skips its frame, never queues; cleared in `finally`.
- Deny unregisters only if `gen` captured at send still equals current.
- Budget: <=100 blits/s total (shared until proven otherwise); Tier A (hero, pipeline, progress) up to 16 ms period, Tier B (divider, tab underline, spark, orbs, telemetry) <=15 fps, static only on data/size change. Repeated frame-budget misses degrade to half rate. Idle (no motion for the displayed run, offline, unfocused, no Raster surface or reduced motion): <=2 fps or on change only; text tick <=1 fps (active <=10 fps).
- Single `$.clock.every(16)` driver; stop with `.cancel()` (Timer has `cancel()`, not callable).
- Motion eligibility derives from the displayed run (not `activeRun(snapshot)`) and is recomputed during render.

## 6. Commands
`npm --prefix packages/claude-plugin run typecheck | test | bench | capture | probe` (probe/capture write `tests/evidence/*`; `capture <label>` writes `<label>-60.txt`/`-140.txt`, default `before`). Full chain verified passing.
