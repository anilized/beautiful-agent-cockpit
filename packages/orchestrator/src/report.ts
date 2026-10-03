import type { Decision, Proposal, Repository, ReviewRecord, Run, SupervisorValidation, Task } from '@cockpit/core';
import type { RunMeta } from './context';

export interface ReportInput {
  run: Run;
  repos: Repository[];
  tasks: Task[];
  reviews: Map<string, ReviewRecord[]>;
  proposals: Proposal[];
  decisions: Decision[];
  validation: SupervisorValidation;
  meta: RunMeta;
  usage: { agentId: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[];
  diffStats: Record<string, string>;
}

/** Final engineering report. Depth follows the Supervisor's reportDepth choice. */
export function buildReport(r: ReportInput): string {
  const depth = r.validation.reportDepth;
  const detailed = depth === 'detailed';
  const brief = depth === 'brief';
  const arch = r.run.architecture as { summary?: string; architecture?: string } | null;
  const lines: string[] = [];
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`## ${title}`, '', ...items.map((i) => `- ${i}`), '');
  };

  lines.push(`# Engineering report: ${r.run.request.split('\n')[0]!.slice(0, 120)}`, '');
  lines.push(`Run \`${r.run.id}\` | round ${r.run.round} | Supervisor verdict: **${r.validation.verdict}**`, '');
  lines.push('## Objective', '', r.run.request, '');
  lines.push('## Summary', '', r.validation.summary, '');
  if (!brief && arch?.summary) lines.push('## Architecture', '', arch.summary, ...(detailed && arch.architecture ? ['', arch.architecture] : []), '');
  section('Architecture decisions', r.validation.architectureDecisions);

  if (r.proposals.length && !brief) {
    lines.push('## Lead proposals and Supervisor decisions', '');
    for (const p of r.proposals) {
      const d = r.decisions.filter((x) => x.proposalId === p.id).at(-1);
      lines.push(`- **${p.title}** (${p.kind}) -> ${d ? `${d.outcome} by ${d.decidedBy}: ${d.rationale}` : p.status}`);
    }
    lines.push('');
  }

  lines.push('## Tasks', '', '| Task | Repo | Status | Iterations | Summary |', '|---|---|---|---|---|');
  for (const t of r.tasks) {
    const repo = r.repos.find((x) => x.id === t.repoId)?.name ?? t.repoId;
    lines.push(`| ${t.key} ${t.title.replace(/\|/g, '/')} | ${repo} | ${t.status} | ${t.iteration} | ${(t.summary ?? t.blockedReason ?? '').replace(/\n/g, ' ').replace(/\|/g, '/').slice(0, 200)} |`);
  }
  lines.push('');

  lines.push('## Repositories and tests', '');
  for (const repo of r.repos) {
    const integ = r.meta.integration?.[repo.id];
    if (!integ) continue;
    lines.push(`### ${repo.name}`, '', `Integration branch: \`${integ.branch}\``, `Integration tests: ${integ.command ? (integ.passed ? `passed (\`${integ.command}\`)` : `**FAILED** (\`${integ.command}\`)`) : 'no test command configured'}`, '');
    if (!brief && r.diffStats[repo.id]) lines.push('```', r.diffStats[repo.id]!.trim(), '```', '');
  }

  if (!brief) {
    const findings: string[] = [];
    for (const t of r.tasks) {
      for (const rev of r.reviews.get(t.id) ?? []) {
        if (rev.verdict === 'approve' && !detailed) continue;
        findings.push(`${t.key} review ${rev.iteration}: ${rev.verdict} - ${rev.summary}${detailed ? rev.issues.map((i) => ` [${i.severity}] ${i.description}`).join(';') : ''}`);
      }
    }
    section('Review findings', findings);
  }
  section('Validation findings', r.validation.findings);
  section('Remaining risks', r.validation.remainingRisks);
  section('Known limitations', r.validation.knownLimitations);
  section('Unresolved issues', [
    ...r.validation.requiredChanges,
    ...r.tasks.filter((t) => ['failed', 'cancelled', 'escalated'].includes(t.status)).map((t) => `${t.key} ${t.status}: ${t.blockedReason ?? ''}`),
  ]);
  section('Recommended follow-up', r.validation.followUps);

  if (r.usage.length) {
    lines.push('## Model usage', '', '| Agent | Model | Calls | Input tokens | Output tokens | Cost (USD) |', '|---|---|---|---|---|---|');
    for (const u of r.usage) lines.push(`| ${u.agentId} | ${u.model} | ${u.calls} | ${u.inputTokens} | ${u.outputTokens} | ${u.costUsd ? u.costUsd.toFixed(4) : '-'} |`);
    lines.push('');
  }
  lines.push('---', 'Decision required: **APPROVE**, **REQUEST CHANGES**, or **REJECT**.');
  return lines.join('\n');
}
