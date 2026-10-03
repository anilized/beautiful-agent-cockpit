import type { AgentProfile, CockpitConfig } from '@cockpit/core';
import type { AdapterFactory, AgentAdapter } from './adapter';
import { ClaudeAdapter } from './claude-adapter';
import { CodexAdapter } from './codex-adapter';

/** Adapter factories by name. New providers (grok, gemini, local) register here. */
export class AdapterRegistry {
  private readonly factories = new Map<string, AdapterFactory>();
  private readonly instances = new Map<string, AgentAdapter>();

  constructor(private readonly config: CockpitConfig) {
    const worker = config.permissions.worker;
    this.register('claude', (p) => new ClaudeAdapter(p, { allowedTools: worker.allowedTools, disallowedTools: worker.disallowedTools }));
    this.register('codex', (p) => new CodexAdapter(p));
  }

  register(name: string, factory: AdapterFactory): void {
    this.factories.set(name, factory);
    this.instances.clear();
  }

  profile(agentId: string): AgentProfile {
    const p = this.config.agents.agents.find((a) => a.id === agentId);
    if (!p) throw new Error(`Unknown agent ${agentId}`);
    return p;
  }

  get(agentId: string): AgentAdapter {
    let inst = this.instances.get(agentId);
    if (!inst) {
      const profile = this.profile(agentId);
      const factory = this.factories.get(profile.adapter);
      if (!factory) throw new Error(`No adapter "${profile.adapter}" registered for agent ${agentId}`);
      inst = factory(profile);
      this.instances.set(agentId, inst);
    }
    return inst;
  }
}
