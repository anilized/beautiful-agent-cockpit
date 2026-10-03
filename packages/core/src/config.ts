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
  /** Default reasoning effort (see effortLevels); null leaves the CLI's own default. A run may override it. */
  effort: z.string().nullable().default(null),
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
  decisions: z
    .object({
      maxRounds: z.number().int().positive().default(2),
      /** Proposals from task reviews: `defer` (the Supervisor rules on them once, at final validation) or `immediate` (a Supervisor call per review). */
      duringTasks: z.enum(['defer', 'immediate']).default('defer'),
    })
    .default({ maxRounds: 2, duringTasks: 'defer' }),
  validation: z.object({ maxRevisions: z.number().int().nonnegative().default(1) }).default({ maxRevisions: 1 }),
  /** `approval`: a plan with a team waits for the human to approve or revise the team before any worker starts. */
  team: z.object({ approval: z.boolean().default(true) }).default({ approval: true }),
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
  resolveRoles(config, {}, 'hierarchy');
  for (const a of config.agents.agents) if (a.effort) checkEffort(config, a.id, a.effort, `agents.yaml (${a.id})`);
  if (!config.agents.agents.some((a) => a.enabled && a.roles.includes('worker'))) throw new Error('No enabled worker agent configured');
  for (const r of config.routing.rules) for (const p of r.prefer) if (!ids.has(p)) throw new Error(`routing rule "${r.name}" prefers unknown agent "${p}"`);
}

export interface RoleChoice {
  supervisor?: string | null;
  lead?: string | null;
}

/**
 * The Supervisor and Lead for a run: the human's choice where given, else the
 * configured hierarchy. Each must be an enabled agent tagged with that role, and
 * the two must differ.
 */
export function resolveRoles(config: CockpitConfig, choice: RoleChoice, source = 'choice'): { supervisor: string; lead: string } {
  const supervisor = choice.supervisor || config.agents.hierarchy.supervisor;
  const lead = choice.lead || config.agents.hierarchy.lead;
  for (const [role, id] of [['supervisor', supervisor], ['lead', lead]] as const) {
    const agent = config.agents.agents.find((a) => a.id === id);
    if (!agent) throw new Error(`${source}: ${role} "${id}" is not a configured agent`);
    if (!agent.enabled) throw new Error(`${source}: ${role} "${id}" is disabled in agents.yaml`);
    if (!agent.roles.includes(role)) {
      const eligible = eligibleFor(config, role).join(', ') || 'none';
      throw new Error(`${source}: "${id}" may not act as ${role} (add "${role}" to its roles in agents.yaml; eligible: ${eligible})`);
    }
  }
  if (supervisor === lead) throw new Error(`${source}: supervisor and lead must be distinct agents`);
  return { supervisor, lead };
}

/** A seat as asked for: the agent, its effort, and for a Lead the area it owns. */
export interface SeatChoice {
  agent: string;
  effort?: string | null;
  area?: string | null;
}

/**
 * Validates a council (role 'supervisor') or a set of leads (role 'lead') and gives each seat an id.
 * The same agent may sit more than once (each seat is its own session at its own effort).
 */
export function resolveSeats(config: CockpitConfig, role: 'supervisor' | 'lead', choices: SeatChoice[], source = 'seats'): { id: string; agent: string; effort: string | null; area: string | null }[] {
  if (!choices.length) throw new Error(`${source}: at least one ${role} is needed`);
  return choices.map((c, i) => {
    const agent = config.agents.agents.find((a) => a.id === c.agent);
    if (!agent) throw new Error(`${source}: ${role} "${c.agent}" is not a configured agent`);
    if (!agent.enabled) throw new Error(`${source}: ${role} "${c.agent}" is disabled in agents.yaml`);
    if (!agent.roles.includes(role)) throw new Error(`${source}: "${c.agent}" may not act as ${role} (eligible: ${eligibleFor(config, role).join(', ') || 'none'})`);
    if (c.effort) checkEffort(config, c.agent, c.effort, source);
    return { id: `${role === 'supervisor' ? 'sup' : 'lead'}-${i + 1}`, agent: c.agent, effort: c.effort ?? null, area: c.area ?? null };
  });
}

/** Enabled agents that may take a role. */
export function eligibleFor(config: CockpitConfig, role: 'supervisor' | 'lead' | 'worker'): string[] {
  return config.agents.agents.filter((a) => a.enabled && a.roles.includes(role)).map((a) => a.id);
}

/** The reasoning effort levels an adapter's CLI accepts, lowest first. */
export function effortLevels(adapter: string): string[] {
  if (adapter === 'codex') return ['minimal', 'low', 'medium', 'high', 'xhigh'];
  return ['low', 'medium', 'high', 'xhigh', 'max']; // claude (and the fake adapter in tests)
}

/**
 * Validates one effort choice. The key is an agent id, or `<role>:<agent>` to set it
 * for that seat only (one agent can hold the lead seat and also work, at different levels).
 */
export function checkEffort(config: CockpitConfig, key: string, effort: string, source = 'effort'): void {
  const sep = key.indexOf(':');
  const role = sep === -1 ? null : key.slice(0, sep);
  const agentId = sep === -1 ? key : key.slice(sep + 1);
  if (role !== null && !['supervisor', 'lead', 'worker'].includes(role)) throw new Error(`${source}: "${role}" is not a role (supervisor, lead, worker)`);
  const agent = config.agents.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`${source}: "${agentId}" is not a configured agent`);
  const levels = effortLevels(agent.adapter);
  if (!levels.includes(effort)) throw new Error(`${source}: "${effort}" is not an effort ${agentId} (${agent.adapter}) accepts (${levels.join(', ')})`);
}
