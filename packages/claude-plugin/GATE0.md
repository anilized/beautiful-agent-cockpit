# Gate 0: what still needs a live Claude Code terminal

Everything below was only measured under the mock clock (`tests/evidence/blitrate.txt`, `npm run bench`). Check each in a real
terminal at 60 and 140 columns with a mission running, and note the result here.

- [ ] Delivered frame rate of the hero (target ~60 fps; the host shows about 60 of the up to 120 blits/s it takes).
- [ ] Input latency while animating: hotkeys and typing in the prompt stay responsive.
- [ ] CPU of the Claude Code process while a mission runs (and near zero at rest).
- [ ] Scope of the ~120/s blit cap (whole plugin or per key). The scheduler assumes the whole plugin and keeps all keys at <= 100/s
      (`MAX_BLITS_PER_S`, hero at 16 ms, other keys every >= `SECONDARY_MS` = 66 ms); loosen those only if the host takes more.
- [ ] Payload cap: no blit of the largest raster (the hero at 140 columns) is denied.
- [ ] Closing the pane (`ui.close`) stops every blit; reopening resumes without a jump.
- [ ] Terminal screenshots at 60 and 140 columns, live and at rest.
