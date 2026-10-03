import type { AgentProfile, Level, RoutingConfig, RoutingStrategy, Task } from '@cockpit/core';

const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };

export interface RoutingDecision {
  agentId: string;
  reason: string;
  candidates: { agentId: string; score: number }[];
}

export type RoutableTask = Pick<Task, 'kind' | 'specialty' | 'risk' | 'complexity'>;

/**
 * Chooses a worker from capability profiles and task metadata. Codex decides the
 * task metadata; the router turns it into an assignment. Opus may change the
 * strategy for a run (quality / cost / speed).
 */
export class AgentRouter {
  constructor(private readonly profiles: AgentProfile[], private readonly config: RoutingConfig) {}

  workers(): AgentProfile[] {
    return this.profiles.filter((p) => p.enabled && p.roles.includes('worker'));
  }

  route(task: RoutableTask, opts: { strategy?: RoutingStrategy; load?: Map<string, number>; exclude?: string[] } = {}): RoutingDecision {
    const strategy = opts.strategy ?? this.config.strategy;
    const load = opts.load ?? new Map();
    const pool = this.workers().filter(
      (p) => !opts.exclude?.includes(p.id) && (p.specialties.includes('*') || p.specialties.includes(task.specialty)) && (load.get(p.id) ?? 0) < p.maxConcurrent,
    );
    const rules = this.config.rules.filter((r) => matches(r.when, task));
    const scored = pool
      .map((p) => {
        let score = 0;
        const reasons: string[] = [];
        for (const r of rules) {
          const idx = r.prefer.indexOf(p.id);
          if (idx !== -1) {
            score += 100 - idx * 10;
            reasons.push(`rule ${r.name}`);
          }
          if (r.requireReasoningDepth && RANK[p.capabilities.reasoningDepth] < RANK[r.requireReasoningDepth]) score -= 1000;
        }
        // Harder / riskier work favours deeper reasoning.
        const demand = Math.max(RANK[task.risk], RANK[task.complexity]);
        score -= Math.max(0, demand - RANK[p.capabilities.reasoningDepth]) * 45;
        if (strategy === 'prefer_quality') score += RANK[p.capabilities.reasoningDepth] * 15;
        if (strategy === 'prefer_cost') score -= RANK[p.capabilities.costTier] * 15;
        if (strategy === 'prefer_speed') score -= RANK[p.capabilities.latencyTier] * 15;
        if (strategy === 'balanced') score -= RANK[p.capabilities.costTier] * 5;
        const fallbackIdx = this.config.fallback.indexOf(p.id);
        if (fallbackIdx !== -1) score += 5 - fallbackIdx;
        score -= (load.get(p.id) ?? 0) * 2;
        return { agentId: p.id, score, reasons };
      })
      .sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));
    const best = scored[0];
    if (!best) throw new Error(`No worker available for ${task.kind}/${task.specialty}`);
    return {
      agentId: best.agentId,
      reason: `${strategy}${best.reasons.length ? `; ${best.reasons.join(', ')}` : ''}; risk=${task.risk} complexity=${task.complexity}`,
      candidates: scored.map(({ agentId, score }) => ({ agentId, score })),
    };
  }
}

function matches(when: RoutingConfig['rules'][number]['when'], task: RoutableTask): boolean {
  if (when.kind && !when.kind.includes(task.kind)) return false;
  if (when.specialty && !when.specialty.includes(task.specialty)) return false;
  if (when.risk && !when.risk.includes(task.risk)) return false;
  if (when.complexity && !when.complexity.includes(task.complexity)) return false;
  return true;
}
