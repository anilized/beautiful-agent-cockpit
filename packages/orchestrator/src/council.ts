import { councilReviewPrompt } from '@cockpit/agents';
import { errorMessage, type CouncilReview, type Run } from '@cockpit/core';
import { arch, councilOf, runRepos, seatCall, type EngineContext } from './context';

export interface CouncilView extends CouncilReview {
  seat: string;
}

/**
 * Asks every council member but the chair for a view on the same material, in parallel.
 * A member that fails is left out (the chair still rules); a council of one returns nothing.
 */
export async function consultCouncil(ctx: EngineContext, run: Run, subject: 'architecture' | 'proposals' | 'result', material: string): Promise<CouncilView[]> {
  const [chair, ...members] = councilOf(ctx, run.id);
  if (!members.length) return [];
  const repos = runRepos(ctx, run);
  const current = ctx.store.runById(run.id) ?? run;
  const views = await Promise.all(
    members.map(async (m): Promise<CouncilView | null> => {
      try {
        const res = await ctx.runner.call({
          runId: run.id, ...seatCall(m), role: 'supervisor', contract: 'CouncilReview',
          prompt: councilReviewPrompt({ seat: `${m.id} (${m.agent})`, chair: `${chair!.id} (${chair!.agent})`, request: run.request, arch: arch(current), subject, material }),
          cwd: repos[0]!.path, additionalDirs: repos.slice(1).map((r) => r.path), readOnly: true,
          timeoutMs: ctx.config.engine.agentTimeoutMs, spanName: `council.${subject}`,
        });
        ctx.bus.emit('council.reviewed', run.id, { seat: m.id, agentId: m.agent, subject, verdict: res.output.verdict, summary: res.output.summary });
        return { seat: `${m.id} (${m.agent})`, ...res.output };
      } catch (err) {
        ctx.bus.emit('council.reviewed', run.id, { seat: m.id, agentId: m.agent, subject, verdict: 'abstain', summary: errorMessage(err).slice(0, 300) });
        return null;
      }
    }),
  );
  return views.filter((v): v is CouncilView => v !== null);
}
