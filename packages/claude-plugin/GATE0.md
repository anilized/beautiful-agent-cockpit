# Gate 0 report: host limits

Status of every item: **pending**. Nothing is released. The default `CADENCE` stays `'conservative'` (`DEFAULT_CADENCE` in `hooks/limits.ts`) until a human fills in or explicitly waives each of the 7 items below.
Items map 1:1 to the fields of `HOST_LIMITS` in `hooks/limits.ts`. Probe: `COCKPIT_TRACE=1` in the blitting process, then `npm --prefix packages/claude-plugin run probe` (dumps HOST_LIMITS, cadence and the trace ring; paste the output under the entry).

## 1. Blit-rate scope and cap: `HOST_LIMITS.blitRate`
- Assumed: 120/s, scope `plugin` (source `default`).
- d.ts: 2178-2180 ("up to 120 a second taken"); scope not stated.
- If live data differs: `HOST_LIMITS.blitRate.value` / `.scope`; `CADENCE.conservative.totalPerSec` and `CADENCE.full.totalPerSec` must stay below it.
- Probe: `npm run probe` after a trace run; count `start` events per second per key and in total.
- Status: pending

## 2. Frames actually shown per second: `HOST_LIMITS.shownFps`
- Assumed: 60 (source `documented`).
- d.ts: 2178-2180 ("some sixty shown").
- If live data differs: `HOST_LIMITS.shownFps.value`; `CADENCE.*.tierAFps`, `CADENCE.*.framePeriodMs`.
- Probe: `npm run probe`; compare `resolve` event spacing against `start` spacing.
- Status: pending

## 3. Payload cap: `HOST_LIMITS.payloadCap`
- Assumed: none known; the `cols*rows*3` uint32-words contract stays binding (source `default`).
- d.ts: 2184-2187 (deny reasons only).
- If live data differs: `HOST_LIMITS.payloadCap.value` (and `.scope`); painter sizes in `hooks/raster.ts` must respect it.
- Probe: `npm run probe`; look for `deny` events on large rasters at 140 columns.
- Status: pending

## 4. Colour-pair cap: `HOST_LIMITS.colorPairCap`
- Assumed: 1024, scope unverified (source `default`).
- d.ts: none.
- If live data differs: `HOST_LIMITS.colorPairCap.value` / `.scope`; palette size in the design tokens.
- Probe: `npm run probe`; `deny` events or visible colour fallback when the palette grows.
- Status: pending

## 5. Does a refused clock period occur in practice: `HOST_LIMITS.clockMinMs`
- Assumed: minimum period 1 ms; a refused period ends the interval (source `documented`).
- d.ts: 3228-3231.
- If live data differs: `HOST_LIMITS.clockMinMs.value`; `CADENCE.*.framePeriodMs`, `CADENCE.*.idlePeriodMs`; the scheduler must re-arm if an interval ends unexpectedly.
- Probe: `npm run probe`; a gap in `start` events while keys are live means the interval ended.
- Status: pending

## 6. `$.ui.panes()` cost: `HOST_LIMITS.panesPollMaxHz`
- Assumed: poll at ≤1 Hz, only while idle or degraded, never the main liveness path (source `default`).
- d.ts: 2308-2319.
- If live data differs: `HOST_LIMITS.panesPollMaxHz.value` (set 0 to disable polling).
- Probe: time `await $.ui.panes()` inside the host and paste the ms figures here.
- Status: pending

## 7. >=30 fps achievable on the real terminal: `HOST_LIMITS.fps30Achievable`
- Assumed: unknown (source `default`).
- d.ts: none.
- If live data differs: `HOST_LIMITS.fps30Achievable.value`; `CADENCE.conservative.tierAFps` / `CADENCE.full.tierAFps`.
- Probe: `npm run probe`; effective `resolve` rate per Tier A key over 10 s on the real terminal.
- Status: pending
