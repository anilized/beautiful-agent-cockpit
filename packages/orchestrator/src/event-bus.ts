import type { CockpitEvent, EventPayloads, EventType } from '@cockpit/core';
import type { Store } from '@cockpit/persistence';

export type EventListener = (event: CockpitEvent) => void;

/** Persists every event (the durable log) and fans it out to in-process subscribers. */
export class EventBus {
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly store: Store) {}

  emit<T extends EventType>(type: T, runId: string | null, data: EventPayloads[T]): CockpitEvent<T> {
    const event = this.store.appendEvent({ type, runId, data });
    for (const l of this.listeners) {
      try {
        l(event as CockpitEvent);
      } catch {
        /* observers never break the workflow */
      }
    }
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
