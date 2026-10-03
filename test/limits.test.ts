import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LimitsStore, claudeLimits, readCodexLimits } from '../packages/orchestrator/src/limits';
import { tempDir } from './helpers';

describe('subscription limits', () => {
  it('reads Claude Code rate_limit_event windows', () => {
    // as `claude -p --output-format stream-json` printed it
    const event = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed', rateLimitType: 'five_hour',
        unifiedWindows: { five_hour: { utilization: 0.14, resetsAt: 1791084000 }, seven_day: { utilization: 0.15, resetsAt: 1791241200 } },
      },
    };
    expect(claudeLimits(event, 'now')).toEqual({
      at: 'now',
      windows: [
        { name: '5h', usedPercent: 14, resetsAt: new Date(1791084000 * 1000).toISOString() },
        { name: '7d', usedPercent: 15, resetsAt: new Date(1791241200 * 1000).toISOString() },
      ],
    });
    expect(claudeLimits({ type: 'rate_limit_event' })).toBeNull();
  });

  it('reads the newest Codex session log for its rate limits', () => {
    const home = tempDir('codex-home');
    const day = join(home, 'sessions', '2026', '10', '04');
    mkdirSync(day, { recursive: true });
    const line = (used: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: used, window_minutes: 300, resets_at: 1791088219 },
      secondary: { used_percent: 16, window_minutes: 10080, resets_at: 1791634258 },
    } } });
    writeFileSync(join(day, 'rollout-a.jsonl'), [line(5), '{"type":"other"}', line(12), '{"type":"turn"}'].join('\n'));
    const l = readCodexLimits(home);
    expect(l?.windows).toEqual([
      { name: '5h', usedPercent: 12, resetsAt: new Date(1791088219 * 1000).toISOString() },
      { name: '7d', usedPercent: 16, resetsAt: new Date(1791634258 * 1000).toISOString() },
    ]);
    expect(readCodexLimits(join(home, 'missing'))).toBeNull();
  });

  it('keeps the latest per provider across restarts and reports only changes', () => {
    const file = join(tempDir('limits'), 'limits.json');
    const a = new LimitsStore(file);
    const v = { windows: [{ name: '5h', usedPercent: 20, resetsAt: null }], at: 't1' };
    expect(a.set('claude', v)).toBe(true);
    expect(a.set('claude', { ...v, at: 't2' })).toBe(false); // same figures
    expect(new LimitsStore(file).get().claude?.windows[0]?.usedPercent).toBe(20);
  });
});
