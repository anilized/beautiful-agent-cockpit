#!/usr/bin/env node
// Entry point: run the TypeScript CLI through tsx without a build step.
const originalEmit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  // node:sqlite is stable enough for local persistence; hide its experimental notice.
  if (String(warning).includes('SQLite')) return;
  return originalEmit.call(process, warning, ...rest);
};

const { register } = await import('tsx/esm/api');
register();
const { main } = await import('../packages/orchestrator/src/cli.ts');
main().catch((err) => {
  console.error(`error: ${err?.message ?? err}`);
  process.exit(1);
});
