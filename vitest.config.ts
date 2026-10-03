import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      ['core', 'persistence', 'telemetry', 'workspace', 'agents', 'transport', 'orchestrator'].map((n) => [`@cockpit/${n}`, pkg(n)]),
    ),
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
