import type { ChildProcess } from 'node:child_process';

export function ephemeralPortStart(): Promise<number>;

export function reserveListenPort(): Promise<number>;

export interface StartedAppServer {
  port: number;
  server: ChildProcess;
  exited: Promise<unknown[]>;
  output(): string;
  stop(): Promise<void>;
}

export function startAppServer(options: {
  label: string;
  env: (port: number) => Record<string, string | undefined>;
  readyPath?: string;
  nodeArguments?: string[];
  entry?: string;
  startupTimeoutMilliseconds?: number;
  ipc?: boolean;
  cwd?: string;
  reservePort?: () => Promise<number>;
}): Promise<StartedAppServer>;

export function publishedPort(
  container: string,
  containerPort: number,
  options?: { attempts?: number },
): Promise<number>;

export function waitForConnections(
  port: number,
  options: { attempts: number; label: string },
): Promise<void>;
