import { supervisorDecisionPrompt } from '@cockpit/agents';
import type { ArchitectureOutput, Proposal, ProposalStatus, Run } from '@cockpit/core';
import { arch, rolesOf, runRepos, type EngineContext, type RunMeta } from './context';

export interface DecisionOutcome {
  humanApprovalId: string | null;
  requestAnalysis: boolean;
}

const STATUS: Record<string, ProposalStatus> = {
  accept: 'accepted',
  accept_with_changes: 'accepted_with_changes',
  reject: 'rejected',
  request_analysis: 'needs_analysis',
  escalate_human: 'escalated',
};

/**
 * The Supervisor decides on the Lead's proposals. Codex -> Opus is the only upward
 * channel; Opus may accept, amend, reject, ask for analysis, or escalate to the human.
 */
export async function decideProposals(ctx: EngineContext, run: Run, assessment: string, proposals: Proposal[]): Promise<DecisionOutcome> {
  const { store, bus, runner, config } = ctx;
  if (!proposals.length) return { humanApprovalId: null, requestAnalysis: false };
  const current = arch(run);
  const repos = runRepos(ctx, run);
  const res = await runner.call({
    runId: run.id,
    agentId: rolesOf(ctx, run.id).supervisor,
    role: 'supervisor',
    contract: 'SupervisorDecisions',
    prompt: supervisorDecisionPrompt(current ?? emptyArch(), assessment, proposals),
    cwd: repos[0]!.path,
    additionalDirs: repos.slice(1).map((r) => r.path),
    readOnly: true,
    timeoutMs: config.engine.agentTimeoutMs,
    spanName: 'opus.decisions',
  });
  const out = res.output;
  let requestAnalysis = false;
  const escalated: Proposal[] = [];
  const decided = new Set<string>();
  for (const d of out.decisions) {
    const p = proposals[d.proposalIndex];
    if (!p || decided.has(p.id)) continue;
    decided.add(p.id);
    store.insertDecision({ runId: run.id, proposalId: p.id, decidedBy: 'supervisor', outcome: d.outcome, rationale: d.rationale, changes: d.changes });
    store.setProposalStatus(p.id, STATUS[d.outcome]!);
    if (d.outcome === 'accept' || d.outcome === 'accept_with_changes') {
      bus.emit('proposal.accepted', run.id, { proposalId: p.id, withChanges: d.outcome === 'accept_with_changes', rationale: d.rationale });
    } else if (d.outcome === 'reject') {
      bus.emit('proposal.rejected', run.id, { proposalId: p.id, rationale: d.rationale });
    } else if (d.outcome === 'request_analysis') {
      requestAnalysis = true;
    } else {
      escalated.push(p);
      bus.emit('proposal.escalated', run.id, { proposalId: p.id, rationale: d.rationale });
    }
  }
  for (const p of proposals) {
    if (decided.has(p.id)) continue;
    store.insertDecision({ runId: run.id, proposalId: p.id, decidedBy: 'supervisor', outcome: 'reject', rationale: 'Not addressed by the Supervisor; treated as rejected.', changes: null });
    store.setProposalStatus(p.id, 'rejected');
    bus.emit('proposal.rejected', run.id, { proposalId: p.id, rationale: 'not addressed' });
  }
  if (out.architectureUpdate && current) {
    store.updateRun(run.id, { architecture: { ...current, architecture: out.architectureUpdate } });
  }
  if (out.routingStrategy) store.setRunMeta(run.id, { routingStrategy: out.routingStrategy } satisfies Partial<RunMeta>);

  let humanApprovalId: string | null = null;
  if (escalated.length || out.questionForHuman) {
    const question = out.questionForHuman ?? escalated.map((p) => `${p.title}: ${p.suggestion}`).join('\n');
    const approval = store.insertApproval({
      runId: run.id,
      kind: 'decision',
      operation: null,
      summary: question.slice(0, 2000),
      details: { proposalIds: escalated.map((p) => p.id), question },
    });
    humanApprovalId = approval.id;
    bus.emit('escalation.requested', run.id, { from: 'lead', to: 'human', reason: question.slice(0, 500) });
    bus.emit('approval.requested', run.id, { approvalId: approval.id, kind: 'decision', summary: approval.summary });
  }
  return { humanApprovalId, requestAnalysis };
}

function emptyArch(): ArchitectureOutput {
  return { summary: '', architecture: '', constraints: [], acceptanceCriteria: [], risks: [], repositoriesInScope: [], guidanceForLead: '' };
}
