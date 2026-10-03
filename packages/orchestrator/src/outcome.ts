import type { ContractName } from '@cockpit/core';

/** At most this many items of a list (tasks, issues, decisions) in an outcome. */
const ITEMS = 12;

const list = <T>(xs: T[], line: (x: T, i: number) => string) =>
  [...xs.slice(0, ITEMS).map(line), ...(xs.length > ITEMS ? [`… ${xs.length - ITEMS} more`] : [])];

/**
 * What a model call concluded, in words: its structured answer read back for the cockpit's
 * Live view. The answer itself drives the orchestrator; this is presentation only.
 */
export function describeOutcome(contract: ContractName, output: unknown): string {
  const o = output as Record<string, any>;
  switch (contract) {
    case 'ArchitectureOutput':
      return [`Architecture: ${o.summary}`, ...list(o.risks ?? [], (r: any) => `risk: ${r.risk}`), `Guidance for the lead: ${o.guidanceForLead}`].join('\n');
    case 'LeadArchitectureReview':
      return [`Assessment: ${o.assessment}`, ...list(o.proposals ?? [], (p: any) => `proposes (${p.kind}): ${p.title}`)].join('\n');
    case 'SupervisorDecisions':
      return [
        `Ruled on ${o.decisions.length} proposal${o.decisions.length === 1 ? '' : 's'}`,
        ...list(o.decisions, (d: any) => `#${d.proposalIndex} ${d.outcome.replace(/_/g, ' ')}: ${d.rationale}`),
        ...(o.questionForHuman ? [`asks you: ${o.questionForHuman}`] : []),
      ].join('\n');
    case 'LeadPlan':
      return [
        `Planned ${o.tasks.length} task${o.tasks.length === 1 ? '' : 's'}${o.notes ? `: ${o.notes}` : ''}`,
        ...list(o.tasks, (t: any) => `${t.key} ${t.title}${t.worker ? ` → ${t.worker}` : ''}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}`),
      ].join('\n');
    case 'WorkerResult':
      return [
        `${o.status}: ${o.summary}`,
        ...(o.filesChanged.length ? [`changed ${o.filesChanged.length} file${o.filesChanged.length === 1 ? '' : 's'}: ${o.filesChanged.slice(0, 6).join(', ')}`] : []),
        ...list(o.testsRun, (t: any) => `${t.passed ? 'passed' : 'FAILED'}: ${t.command}`),
        ...list(o.questions, (q: string) => `asks: ${q}`),
      ].join('\n');
    case 'LeadAnswer':
      return `Answer: ${o.answer}${o.escalateToSupervisor ? `\nescalates: ${o.escalationQuestion ?? ''}` : ''}`;
    case 'SupervisorEscalation':
      return `${o.action.replace(/_/g, ' ')}: ${o.guidance}`;
    case 'LeadReview':
      return [`${o.verdict.replace(/_/g, ' ')}: ${o.summary}`, ...list(o.issues, (i: any) => `${i.severity}${i.file ? ` ${i.file}` : ''}: ${i.description}`)].join('\n');
    case 'LeadLeaseDecision':
      return `${o.action}: ${o.rationale}`;
    case 'LeadIntegrationResult':
      return `${o.resolved ? 'resolved' : 'not resolved'}: ${o.summary}`;
    case 'SupervisorValidation':
      return [`${o.verdict}: ${o.summary}`, ...list(o.requiredChanges ?? [], (c: string) => `required: ${c}`)].join('\n');
    case 'SupervisorRevision':
      return `Direction: ${o.guidance}`;
    default:
      return JSON.stringify(output).slice(0, 2000);
  }
}
