import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';

const level = z.enum(['low', 'medium', 'high']);
const role = z.enum(['supervisor', 'lead', 'worker']);

export const AgentCapabilities = z.object({
  reasoningDepth: level.default('medium'),
  costTier: level.default('medium'),
  latencyTier: level.default('medium'),
  maxContextTokens: z.number().int().positive().default(200_000),
  canEditFiles: z.boolean().default(true),
  canExecuteShell: z.boolean().default(true),
});

export const AgentProfile = z.object({
  id: z.string(),
  adapter: z.string(),
  model: z.string().nullable().default(null),
  roles: z.array(role).min(1),
  /** Worker specialties this agent accepts; "*" means any. */
  specialties: z.array(z.string()).default(['*']),
  capabilities: AgentCapabilities.default(AgentCapabilities.parse({})),
  maxConcurrent: z.number().int().positive().default(4),
  enabled: z.boolean().default(true),
  /** Adapter-specific options (binary path, permission mode, sandbox, extra args...). */
  options: z.record(z.string(), z.unknown()).default({}),
});

export const AgentsConfig = z.object({
  hierarchy: z.object({ supervisor: z.string(), lead: z.string() }),
  agents: z.array(AgentProfile).min(1),
});

export const RoutingRule = z.object({
  name: z.string(),
  when: z
    .object({
      kind: z.array(z.string()).optional(),
      specialty: z.array(z.string()).optional(),
      risk: z.array(level).optional(),
      complexity: z.array(level).optional(),
    })
    .default({}),
  prefer: z.array(z.string()).default([]),
  requireReasoningDepth: level.optional(),
});

export const RoutingStrategy = z.enum(['balanced', 'prefer_quality', 'prefer_cost', 'prefer_speed']);

export const RoutingConfig = z.object({
  strategy: RoutingStrategy.default('balanced'),
  rules: z.array(RoutingRule).default([]),
  fallback: z.array(z.string()).default([]),
});

export const HighRiskOperationSchema = z.enum([
  'merge_protected', 'protected_push', 'production', 'destructive_migration',
  'secret_access', 'cloud_infrastructure', 'destructive_shell', 'external_side_effect',
]);

export const PermissionsConfig = z.object({
  requireApproval: z.array(HighRiskOperationSchema).default(HighRiskOperationSchema.options),
  protectedBranches: z.array(z.string()).default(['main', 'master', 'release/*', 'production']),
  /** Regexes classifying shell commands into high-risk operations. */
  classifiers: z.partialRecord(HighRiskOperationSchema, z.array(z.string())).default({}),
  worker: z
    .object({
      allowedTools: z.array(z.string()).default([]),
      disallowedTools: z.array(z.string()).default([]),
    })
    .default({ allowedTools: [], disallowedTools: [] }),
});

export const EngineConfig = z.object({
  dataDir: z.string().default(join(homedir(), '.agent-cockpit')),
  maxParallelTasks: z.number().int().positive().default(4),
  review: z.object({ maxIterations: z.number().int().positive().default(3) }).default({ maxIterations: 3 }),
  decisions: z.object({ maxRounds: z.number().int().positive().default(2) }).default({ maxRounds: 2 }),
  validation: z.object({ maxRevisions: z.number().int().nonnegative().default(1) }).default({ maxRevisions: 1 }),
  agentTimeoutMs: z.number().int().positive().default(45 * 60_000),
  testTimeoutMs: z.number().int().positive().default(15 * 60_000),
  /** "merge": on final approval merge the integration branch into the base branch. "branch": leave it for the human. */
  finalMerge: z.enum(['merge', 'branch']).default('merge'),
  telemetry: z
    .object({
      otlpEndpoint: z.string().nullable().default(null),
      fileExport: z.boolean().default(true),
    })
    .default({ otlpEndpoint: null, fileExport: true }),
  transport: z.object({ port: z.number().int().nonnegative().default(0) }).default({ port: 0 }),
});

export type AgentCapabilities = z.infer<typeof AgentCapabilities>;
export type AgentProfile = z.infer<typeof AgentProfile>;
export type AgentsConfig = z.infer<typeof AgentsConfig>;
export type RoutingRule = z.infer<typeof RoutingRule>;
export type RoutingStrategy = z.infer<typeof RoutingStrategy>;
export type RoutingConfig = z.infer<typeof RoutingConfig>;
export type PermissionsConfig = z.infer<typeof PermissionsConfig>;
export type EngineConfig = z.infer<typeof EngineConfig>;

export interface CockpitConfig {
  engine: EngineConfig;
  agents: AgentsConfig;
  routing: RoutingConfig;
  permissions: PermissionsConfig;
}

function readYaml(path: string): unknown {
  return existsSync(path) ? (YAML.parse(readFileSync(path, 'utf8')) ?? {}) : {};
}

/** Load config/*.yaml from a directory. Missing files fall back to defaults (agents.yaml is required). */
export function loadConfig(dir: string, overrides: Partial<{ engine: Partial<EngineConfig> }> = {}): CockpitConfig {
  const engineRaw = { ...(readYaml(join(dir, 'cockpit.yaml')) as object), ...(overrides.engine ?? {}) };
  if (process.env.COCKPIT_DATA_DIR) (engineRaw as Record<string, unknown>).dataDir = process.env.COCKPIT_DATA_DIR;
  const config: CockpitConfig = {
    engine: EngineConfig.parse(engineRaw),
    agents: AgentsConfig.parse(readYaml(join(dir, 'agents.yaml'))),
    routing: RoutingConfig.parse(readYaml(join(dir, 'routing.yaml'))),
    permissions: PermissionsConfig.parse(readYaml(join(dir, 'permissions.yaml'))),
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config: CockpitConfig): void {
  const ids = new Set(config.agents.agents.map((a) => a.id));
  const { supervisor, lead } = config.agents.hierarchy;
  if (!ids.has(supervisor)) throw new Error(`hierarchy.supervisor "${supervisor}" is not a configured agent`);
  if (!ids.has(lead)) throw new Error(`hierarchy.lead "${lead}" is not a configured agent`);
  if (supervisor === lead) throw new Error('Supervisor and lead must be distinct agents');
  if (!config.agents.agents.some((a) => a.enabled && a.roles.includes('worker'))) throw new Error('No enabled worker agent configured');
  for (const r of config.routing.rules) for (const p of r.prefer) if (!ids.has(p)) throw new Error(`routing rule "${r.name}" prefers unknown agent "${p}"`);
}
