import { describe, expect, it } from 'vitest';
import { classifyTool, parseToolLine } from '../packages/garage/src/tools';
import type { ToolContext } from '../packages/garage/src/model';

const ctx: ToolContext = { bay: 'bay-3', repo: 'agent-cockpit', testCommand: 'npx vitest run test/garage-tools.test.ts' };
const noTest: ToolContext = { bay: 'bay-3', repo: 'agent-cockpit', testCommand: null };

describe('classifyTool', () => {
  const table: Array<[string, string, ToolContext, { kind: string; state: string; station: string } | null]> = [
    ['Claude Read', 'Read: packages/core/src/index.ts', ctx, { kind: 'read', state: 'researching', station: 'crate:agent-cockpit' }],
    ['Claude Grep', 'Grep: applyEvent', ctx, { kind: 'read', state: 'researching', station: 'crate:agent-cockpit' }],
    ['Claude Glob', 'Glob: **/*.ts', ctx, { kind: 'read', state: 'researching', station: 'crate:agent-cockpit' }],
    ['Claude Edit', 'Edit: packages/garage/src/tools.ts', ctx, { kind: 'edit', state: 'implementing', station: 'bay:bay-3' }],
    ['Claude Write', 'Write: packages/garage/src/sse.ts', ctx, { kind: 'edit', state: 'implementing', station: 'bay:bay-3' }],
    ['Claude MultiEdit', 'MultiEdit: a.ts', ctx, { kind: 'edit', state: 'implementing', station: 'bay:bay-3' }],
    ['apply_patch', 'apply_patch: *** Begin Patch', ctx, { kind: 'edit', state: 'implementing', station: 'bay:bay-3' }],
    ['Codex edit', 'edit: [{"path":"a.ts","kind":"update"}]', ctx, { kind: 'edit', state: 'implementing', station: 'bay:bay-3' }],
    ['Claude Bash running the test command', 'Bash: npx vitest run test/garage-tools.test.ts', ctx, { kind: 'test', state: 'testing', station: 'lab' }],
    ['Codex shell running the test command', 'shell: npx vitest run test/garage-tools.test.ts', ctx, { kind: 'test', state: 'testing', station: 'lab' }],
    ['test command inside a compound command', 'Bash: cd packages && npx vitest run test/garage-tools.test.ts 2>&1 | tail', ctx, { kind: 'test', state: 'testing', station: 'lab' }],
    ['test command with different whitespace', 'Bash: npx   vitest run  test/garage-tools.test.ts', ctx, { kind: 'test', state: 'testing', station: 'lab' }],
    ['other Bash', 'Bash: git status', ctx, { kind: 'shell', state: 'implementing', station: 'terminal' }],
    ['other shell', 'shell: ls -la', ctx, { kind: 'shell', state: 'implementing', station: 'terminal' }],
    ['a partial test command is not a match', 'Bash: npx vitest run', ctx, { kind: 'shell', state: 'implementing', station: 'terminal' }],
    ['no test command known', 'Bash: npx vitest run', noTest, { kind: 'shell', state: 'implementing', station: 'terminal' }],
    ['empty detail', 'Bash: ', ctx, { kind: 'shell', state: 'implementing', station: 'terminal' }],
    ['bare name and colon', 'Read:', ctx, { kind: 'read', state: 'researching', station: 'crate:agent-cockpit' }],
    ['unknown Claude tool', 'WebFetch: https://example.com', ctx, null],
    ['Task tool', 'Task: explore the repo', ctx, null],
    ['MCP tool', 'mcp__server__tool: x', ctx, null],
    ['no colon', 'Read the file', ctx, null],
    ['prose with a colon later', 'I will Read: the file', ctx, null],
    ['empty line', '', ctx, null],
    ['read with no repo', 'Read: a.ts', { ...ctx, repo: null }, null],
    ['edit with no bay', 'Edit: a.ts', { ...ctx, bay: null }, null],
    ['shell needs no bay or repo', 'Bash: pwd', { bay: null, repo: null, testCommand: null }, { kind: 'shell', state: 'implementing', station: 'terminal' }],
    ['test needs no bay or repo', 'Bash: npm test', { bay: null, repo: null, testCommand: 'npm test' }, { kind: 'test', state: 'testing', station: 'lab' }],
  ];

  it.each(table)('%s', (_name, line, c, expected) => {
    expect(classifyTool(line, c)).toEqual(expected);
  });

  it('is case-insensitive on the tool name', () => {
    expect(classifyTool('read: a.ts', ctx)?.station).toBe('crate:agent-cockpit');
    expect(classifyTool('BASH: pwd', ctx)?.station).toBe('terminal');
  });

  it('puts the station on the task the context names', () => {
    expect(classifyTool('Edit: a.ts', { ...ctx, bay: 'bay-6' })?.station).toBe('bay:bay-6');
    expect(classifyTool('Grep: x', { ...ctx, repo: 'other' })?.station).toBe('crate:other');
  });
});

describe('parseToolLine', () => {
  it('splits the name from the detail, keeping later colons in the detail', () => {
    expect(parseToolLine('Bash: echo a: b')).toEqual({ name: 'Bash', detail: 'echo a: b' });
    expect(parseToolLine('Read:')).toEqual({ name: 'Read', detail: '' });
  });
  it('rejects lines without a tool name', () => {
    expect(parseToolLine(': x')).toBeNull();
    expect(parseToolLine('two words: x')).toBeNull();
    expect(parseToolLine('plain')).toBeNull();
  });
});
