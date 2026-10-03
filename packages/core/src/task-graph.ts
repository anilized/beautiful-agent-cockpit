export class CycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Dependency cycle: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
  }
}

/** Directed acyclic dependency graph over task ids (edge: task -> dependency). */
export class TaskGraph {
  private readonly deps = new Map<string, Set<string>>();

  constructor(nodes: Iterable<string> = [], edges: Iterable<{ taskId: string; dependsOn: string }> = []) {
    for (const n of nodes) this.addNode(n);
    for (const e of edges) this.addEdge(e.taskId, e.dependsOn);
  }

  addNode(id: string): void {
    if (!this.deps.has(id)) this.deps.set(id, new Set());
  }

  addEdge(taskId: string, dependsOn: string): void {
    if (taskId === dependsOn) throw new CycleError([taskId, taskId]);
    this.addNode(taskId);
    this.addNode(dependsOn);
    this.deps.get(taskId)!.add(dependsOn);
  }

  nodes(): string[] {
    return [...this.deps.keys()];
  }

  dependenciesOf(id: string): string[] {
    return [...(this.deps.get(id) ?? [])];
  }

  dependentsOf(id: string): string[] {
    return this.nodes().filter((n) => this.deps.get(n)!.has(id));
  }

  /** Throws CycleError if the graph is not a DAG. */
  validate(): void {
    this.topologicalOrder();
  }

  topologicalOrder(): string[] {
    const state = new Map<string, 'visiting' | 'done'>();
    const order: string[] = [];
    const stack: string[] = [];
    const visit = (n: string) => {
      const s = state.get(n);
      if (s === 'done') return;
      if (s === 'visiting') {
        const start = stack.indexOf(n);
        throw new CycleError([...stack.slice(start), n]);
      }
      state.set(n, 'visiting');
      stack.push(n);
      for (const d of this.deps.get(n) ?? []) visit(d);
      stack.pop();
      state.set(n, 'done');
      order.push(n);
    };
    for (const n of [...this.deps.keys()].sort()) visit(n);
    return order;
  }

  /** Nodes whose dependencies are all in `satisfied`. */
  readyNodes(candidates: Iterable<string>, satisfied: ReadonlySet<string>): string[] {
    return [...candidates].filter((n) => this.dependenciesOf(n).every((d) => satisfied.has(d)));
  }
}
