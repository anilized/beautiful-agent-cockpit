# Gate 0 report: host limits

Status of every item: **pending**. The default `CADENCE` stays `'conservative'` (`DEFAULT_CADENCE` in `hooks/limits.ts`) until a human fills in or explicitly waives each of the 7 items below.
The human approved the live-validation request but named no per-item waivers, so nothing is waived.
Items map 1:1 to the fields of `HOST_LIMITS` in `hooks/limits.ts`.

Evidence source: the exported trace (`{version, cadence, hostLimits, keys}`), produced only with `COCKPIT_TRACE=1` (read via `$.env.get`, d.ts:3360-3370) and only on an explicit trigger: the `/cockpit trace` command, `ui.close` or `session.end`. No data-dir write API is documented, so the command returns the serialized JSON; save it to a file and run the probe below. Paste the probe output under the entry.

## 1. Blit-rate cap and scope: `HOST_LIMITS.blitRateCap`
- Assumed: 120/s, scope per plugin (tag `default`).
- d.ts: 2178-2180 ("up to 120 a second taken"); scope not stated.
- If live data differs: `HOST_LIMITS.blitRateCap.value`; keep `CADENCE.conservative.totalPerSec` and `CADENCE.full.totalPerSec` below it.
- Probe: `npm run probe -- <trace.json>` (total blits/s, `deny` counts).
- Status: pending

## 2. Frames shown per second: `HOST_LIMITS.framesShownPerSec`
- Assumed: ~60 (tag `documented`).
- d.ts: 2178-2180 ("some sixty shown").
- If live data differs: `HOST_LIMITS.framesShownPerSec.value`; `CADENCE.*.tierAFps`, `CADENCE.*.framePeriodMs`.
- Probe: `npm run probe -- <trace.json>` (delivered fps and resolve latency per key).
- Status: pending

## 3. Payload cap: `HOST_LIMITS.payloadCapBytes`
- Assumed: none known; the `cols*rows*3` uint32-words contract stays binding (tag `unverified`).
- d.ts: none.
- If live data differs: `HOST_LIMITS.payloadCapBytes.value`; painter sizes in `hooks/raster.ts` must respect it.
- Probe: `npm run probe -- <trace.json>` (`deny` events on large rasters at 140 columns).
- Status: pending

## 4. Colour-pair cap: `HOST_LIMITS.colorPairCap`
- Assumed: 1024, scope (per raster, pane or terminal) unverified (tag `unverified`).
- d.ts: 8429 ("paints 1024 distinct color pairs at once and the rest as their nearest").
- If live data differs: `HOST_LIMITS.colorPairCap.value`; palette size in the design tokens (`hooks/theme.ts`).
- Probe: `npm run probe -- <trace.json>` (`deny` events or visible colour fallback as the palette grows).
- Status: pending

## 5. Clock minimum period: `HOST_LIMITS.clockMinPeriodMs`
- Assumed: 1 ms; a refused period ends the interval (tag `documented`).
- d.ts: 3228-3231.
- If live data differs: `HOST_LIMITS.clockMinPeriodMs.value`; `CADENCE.*.framePeriodMs`, `CADENCE.*.idlePeriodMs`; the scheduler must re-arm an interval that ends.
- Probe: `npm run probe -- <trace.json>` (gaps in `start` events while keys are live).
- Status: pending

## 6. `$.ui.panes()` cost: `HOST_LIMITS.panesCostMs`
- Assumed: unknown; our poll ceiling is `PANES_POLL_MAX_HZ` = 1 (tag `unverified`).
- d.ts: 2308-2319 (no cost stated).
- If live data differs: `HOST_LIMITS.panesCostMs.value`, `PANES_POLL_MAX_HZ` (0 disables polling).
- Probe: not in the trace; time `await $.ui.panes()` in the host and paste the ms figures; `npm run probe -- <trace.json>` lists the item.
- Status: pending

## 7. >=30 fps on the real terminal: `HOST_LIMITS.realTerminalFps`
- Assumed: 30 as the target, achievability unknown (tag `unverified`).
- d.ts: none.
- If live data differs: `HOST_LIMITS.realTerminalFps.value`; `CADENCE.conservative.tierAFps`, `CADENCE.full.tierAFps`.
- Probe: `npm run probe -- <trace.json>` (delivered fps per Tier A key, hero and pipeline, over a 10 s window).
- Status: pending
