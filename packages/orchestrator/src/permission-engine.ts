import { matchGlob, type HighRiskOperation, type PermissionsConfig } from '@cockpit/core';

/** Built-in classifiers; permissions.yaml adds to them. */
const DEFAULT_CLASSIFIERS: Partial<Record<HighRiskOperation, string[]>> = {
  destructive_shell: [
    String.raw`\brm\s+(-\w*r\w*f|-\w*f\w*r)\b`, String.raw`\brmdir\s+/s\b`, String.raw`\bdel\s+/[sq]`, String.raw`\bformat\s+[a-z]:`,
    String.raw`\bgit\s+(reset\s+--hard|clean\s+-\w*f)`, String.raw`\bmkfs\b`, String.raw`\bdd\s+if=`, String.raw`Remove-Item\b.*-Recurse`,
  ],
  protected_push: [String.raw`\bgit\s+push\b`],
  production: [String.raw`\b(deploy|release)\b.*\b(prod|production)\b`, String.raw`\bkubectl\s+(apply|delete|scale|rollout)\b`, String.raw`\bhelm\s+(install|upgrade|uninstall)\b`],
  destructive_migration: [String.raw`\bdrop\s+(table|database|schema)\b`, String.raw`\btruncate\s+table\b`, String.raw`\bmigrate\b.*\b(reset|down|rollback)\b`],
  cloud_infrastructure: [String.raw`\bterraform\s+(apply|destroy)\b`, String.raw`\b(aws|gcloud|az)\s+\S+\s+(create|delete|update|put)`, String.raw`\bpulumi\s+(up|destroy)\b`],
  secret_access: [String.raw`\.env\b`, String.raw`\b(secret|credential|private[_-]?key)s?\b`, String.raw`\b(aws|gcloud|az)\s+.*secrets?\b`],
  external_side_effect: [String.raw`\b(npm|pnpm|yarn)\s+publish\b`, String.raw`\bcurl\b.*-X\s*(POST|PUT|DELETE|PATCH)`, String.raw`\bsendmail\b`],
};

export interface PermissionCheck {
  operations: HighRiskOperation[];
  requiresApproval: boolean;
}

/** Classifies operations the orchestrator is about to perform and decides when the human must approve. */
export class PermissionEngine {
  private readonly classifiers: [HighRiskOperation, RegExp][];

  constructor(private readonly config: PermissionsConfig) {
    this.classifiers = [];
    const all = new Map<HighRiskOperation, string[]>();
    for (const [op, pats] of Object.entries(DEFAULT_CLASSIFIERS)) all.set(op as HighRiskOperation, [...pats]);
    for (const [op, pats] of Object.entries(config.classifiers)) all.set(op as HighRiskOperation, [...(all.get(op as HighRiskOperation) ?? []), ...(pats ?? [])]);
    for (const [op, pats] of all) for (const p of pats) this.classifiers.push([op, new RegExp(p, 'i')]);
  }

  isProtectedBranch(branch: string, extra: string[] = []): boolean {
    return [...this.config.protectedBranches, ...extra].some((p) => p === branch || matchGlob(p, branch));
  }

  requiresApproval(op: HighRiskOperation): boolean {
    return this.config.requireApproval.includes(op);
  }

  classifyCommand(command: string): HighRiskOperation[] {
    const ops = new Set<HighRiskOperation>();
    for (const [op, re] of this.classifiers) if (re.test(command)) ops.add(op);
    return [...ops];
  }

  checkCommand(command: string): PermissionCheck {
    const operations = this.classifyCommand(command);
    return { operations, requiresApproval: operations.some((o) => this.requiresApproval(o)) };
  }

  checkMerge(targetBranch: string, protectedBranches: string[] = []): PermissionCheck {
    const operations: HighRiskOperation[] = this.isProtectedBranch(targetBranch, protectedBranches) ? ['merge_protected'] : [];
    return { operations, requiresApproval: operations.some((o) => this.requiresApproval(o)) };
  }
}
