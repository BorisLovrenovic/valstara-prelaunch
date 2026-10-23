export const stampName: string;

export function buildEnvironment(
  environment: Record<string, string | undefined>,
): [string, string | undefined][];

export function inputDigest(
  root?: string,
  environment?: Record<string, string | undefined>,
): Promise<string>;

export function outputDigest(root?: string): Promise<string>;

export function ensureAppBuild(options?: {
  root?: string;
  env?: Record<string, string | undefined>;
}): Promise<{ built: boolean }>;
