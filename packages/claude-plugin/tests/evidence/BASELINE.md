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
