// Classifies the `Tool: detail` line an agent.output of kind `tool` carries. Pure: no DOM, no node, no clock.
// Shared by applyEvent and fromSnapshot so the live fold and the snapshot agree on fine state and station.
import type { ToolClassification, ToolContext, ToolKind, ToolState } from './model.js';

// Claude's tool names are capitalized (Read, Edit, Bash), Codex's are `shell` and `edit`; names are matched case-insensitively.
const READ_TOOLS = new Set(['read', 'grep', 'glob']);
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch']);
const SHELL_TOOLS = new Set(['bash', 'shell']);

const NAME = /^[A-Za-z_][\w-]*$/;

/** Splits `Tool: detail` into the tool name and its detail; null when the line has no tool name in front of a colon. */
export function parseToolLine(line: string): { name: string; detail: string } | null {
  const i = line.indexOf(':');
  if (i <= 0) return null;
  const name = line.slice(0, i);
  if (!NAME.test(name)) return null;
  return { name, detail: line.slice(i + 1).replace(/^\s+/, '') };
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * What a tool call means for the character that made it:
 * Read/Grep/Glob research at `crate:<repo>`, Edit/Write/MultiEdit/apply_patch/edit implement at `bay:<bay>`,
 * a shell command containing the task's test command tests at `lab`, any other shell goes to the `terminal`.
 * Null when the tool is unknown, or when the station needs a repo or bay the task does not have: the character then
 * keeps its coarse live state rather than standing somewhere invented.
 */
export function classifyTool(line: string, ctx: ToolContext): ToolClassification | null {
  const parsed = parseToolLine(line);
  if (!parsed) return null;
  const name = parsed.name.toLowerCase();
  if (READ_TOOLS.has(name)) return ctx.repo ? done('read', 'researching', `crate:${ctx.repo}`) : null;
  if (EDIT_TOOLS.has(name)) return ctx.bay ? done('edit', 'implementing', `bay:${ctx.bay}`) : null;
  if (SHELL_TOOLS.has(name)) {
    const test = ctx.testCommand ? squash(ctx.testCommand) : '';
    return test && squash(parsed.detail).includes(test) ? done('test', 'testing', 'lab') : done('shell', 'implementing', 'terminal');
  }
  return null;
}

function done(kind: ToolKind, state: ToolState, station: ToolClassification['station']): ToolClassification {
  return { kind, state, station };
}
