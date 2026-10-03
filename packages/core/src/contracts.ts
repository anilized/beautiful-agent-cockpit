import { z } from 'zod';

// Structured outputs exchanged with agents. Every schema is strict (no extra keys,
// every key required, optional values expressed as nullable) so the same JSON Schema
// is accepted by both Claude (--json-schema) and Codex (--output-schema).

const level = z.enum(['low', 'medium', 'high']);
const strings = z.array(z.string());

export const taskKind = z.enum([
  'implementation', 'bugfix', 'refactor', 'test', 'database', 'api', 'docs', 'analysis', 'research', 'security', 'performance',
]);
export const specialty = z.enum([
  'backend', 'frontend', 'test', 'database', 'security', 'performance', 'documentation', 'refactoring', 'research', 'generalist',
]);
export const proposalKind = z.enum(['architecture', 'scope', 'risk', 'alternative', 'resource', 'plan_revision', 'implementation']);

export const proposalInput = z.strictObject({
  kind: proposalKind,
  title: z.string(),
  rationale: z.string(),
  suggestion: z.string(),
});

/** Opus: architecture for the human's request. */
export const ArchitectureOutput = z.strictObject({
  summary: z.string(),
  architecture: z.string(),
  constraints: strings,
  acceptanceCriteria: strings,
  risks: z.array(z.strictObject({ risk: z.string(), mitigation: z.string() })),
  repositoriesInScope: strings,
  guidanceForLead: z.string(),
});

/** Codex: challenge / improve the architecture with implementation evidence. */
export const LeadArchitectureReview = z.strictObject({
  assessment: z.string(),
  proposals: z.array(proposalInput),
});

/** Opus: decisions on Codex proposals. */
export const SupervisorDecisions = z.strictObject({
  decisions: z.array(
    z.strictObject({
      proposalIndex: z.number().int(),
      outcome: z.enum(['accept', 'accept_with_changes', 'reject', 'request_analysis', 'escalate_human']),
      rationale: z.string(),
      changes: z.string().nullable(),
    }),
  ),
  architectureUpdate: z.string().nullable(),
  questionForHuman: z.string().nullable(),
  /** Opus may change how Codex routes work for the rest of the run. */
  routingStrategy: z.enum(['balanced', 'prefer_quality', 'prefer_cost', 'prefer_speed']).nullable(),
});

/** Codex: decomposition into a dependency graph of tasks. */
export const LeadPlan = z.strictObject({
  notes: z.string(),
  tasks: z.array(
    z.strictObject({
      key: z.string(),
      title: z.string(),
      description: z.string(),
      kind: taskKind,
      repository: z.string(),
      specialty,
      risk: level,
      complexity: level,
      /** The worker the Lead assigns (an enabled worker's id), or null to let the router choose. */
      worker: z.string().nullable(),
      files: strings,
      modules: strings,
      resources: strings,
      dependsOn: strings,
      acceptanceCriteria: strings,
      testsRequired: z.boolean(),
      testCommand: z.string().nullable(),
    }),
  ),
});

/** Worker: result of one execution turn. */
export const WorkerResult = z.strictObject({
  status: z.enum(['completed', 'needs_input', 'blocked']),
  summary: z.string(),
  filesChanged: strings,
  testsAdded: strings,
  testsRun: z.array(z.strictObject({ command: z.string(), passed: z.boolean() })),
  questions: strings,
  leaseRequests: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
  notes: z.string().nullable(),
});

/** Codex: answer to a worker's question. */
export const LeadAnswer = z.strictObject({
  answer: z.string(),
  escalateToSupervisor: z.boolean(),
  escalationQuestion: z.string().nullable(),
});

/** Opus: answer to an escalated question or a failing task. */
export const SupervisorEscalation = z.strictObject({
  action: z.enum(['retry_with_guidance', 'abandon_task', 'escalate_human']),
  guidance: z.string(),
});

/** Codex: review of a worker's submission. */
export const LeadReview = z.strictObject({
  verdict: z.enum(['approve', 'changes_requested', 'escalate']),
  summary: z.string(),
  issues: z.array(
    z.strictObject({
      severity: z.enum(['blocker', 'major', 'minor']),
      file: z.string().nullable(),
      description: z.string(),
      suggestion: z.string().nullable(),
    }),
  ),
  testsAdequate: z.boolean(),
  proposals: z.array(proposalInput),
});

/** Codex: what to do about a lease conflict discovered during execution. */
export const LeadLeaseDecision = z.strictObject({
  action: z.enum(['wait', 'transfer', 'serialize', 'escalate']),
  rationale: z.string(),
});

/** Codex: merge-conflict resolution inside the integration worktree. */
export const LeadIntegrationResult = z.strictObject({
  resolved: z.boolean(),
  summary: z.string(),
});

/** Opus: final architectural validation and report content. */
export const SupervisorValidation = z.strictObject({
  verdict: z.enum(['accept', 'revise']),
  summary: z.string(),
  reportDepth: z.enum(['brief', 'standard', 'detailed']),
  architectureDecisions: strings,
  findings: strings,
  requiredChanges: strings,
  remainingRisks: strings,
  knownLimitations: strings,
  followUps: strings,
  /** Rulings on the Lead's proposals from task reviews, deferred to this validation. */
  proposalDecisions: z.array(
    z.strictObject({
      proposalIndex: z.number().int(),
      outcome: z.enum(['accept', 'reject']),
      rationale: z.string(),
    }),
  ),
});

/** Opus: revised direction after the human requests changes or validation asks for revision. */
export const SupervisorRevision = z.strictObject({
  guidance: z.string(),
  architectureUpdate: z.string().nullable(),
});

export type ArchitectureOutput = z.infer<typeof ArchitectureOutput>;
export type LeadArchitectureReview = z.infer<typeof LeadArchitectureReview>;
export type SupervisorDecisions = z.infer<typeof SupervisorDecisions>;
export type LeadPlan = z.infer<typeof LeadPlan>;
export type PlannedTask = LeadPlan['tasks'][number];
export type WorkerResult = z.infer<typeof WorkerResult>;
export type LeadAnswer = z.infer<typeof LeadAnswer>;
export type SupervisorEscalation = z.infer<typeof SupervisorEscalation>;
export type LeadReview = z.infer<typeof LeadReview>;
export type LeadLeaseDecision = z.infer<typeof LeadLeaseDecision>;
export type LeadIntegrationResult = z.infer<typeof LeadIntegrationResult>;
export type SupervisorValidation = z.infer<typeof SupervisorValidation>;
export type SupervisorRevision = z.infer<typeof SupervisorRevision>;
export type ProposalInput = z.infer<typeof proposalInput>;

export const Contracts = {
  ArchitectureOutput,
  LeadArchitectureReview,
  SupervisorDecisions,
  LeadPlan,
  WorkerResult,
  LeadAnswer,
  SupervisorEscalation,
  LeadReview,
  LeadLeaseDecision,
  LeadIntegrationResult,
  SupervisorValidation,
  SupervisorRevision,
} as const;

export type ContractName = keyof typeof Contracts;
export type ContractOf<N extends ContractName> = z.infer<(typeof Contracts)[N]>;

export function contractJsonSchema(name: ContractName): Record<string, unknown> {
  const schema = z.toJSONSchema(Contracts[name], { target: 'draft-7' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function parseContract<N extends ContractName>(name: N, value: unknown): ContractOf<N> {
  return Contracts[name].parse(value) as ContractOf<N>;
}
