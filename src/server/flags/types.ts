import type { FlagKey } from './registry.ts';

export interface Flag {
  readonly enabled: boolean;
  readonly key: FlagKey;
}

export interface FlagService {
  isEnabled(key: FlagKey): Promise<boolean>;
  list(): Promise<readonly Flag[]>;
  set(key: FlagKey, enabled: boolean, actor: string): Promise<void>;
}

export interface FlagClock {
  now(): number;
}
