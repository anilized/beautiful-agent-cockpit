import { randomUUID } from 'node:crypto';

export * from './domain';
export * from './events';
export * from './state-machine';
export * from './task-graph';
export * from './scope';
export * from './conflict-graph';
export * from './contracts';
export * from './config';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
