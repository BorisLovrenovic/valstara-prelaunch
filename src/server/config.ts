import { fileURLToPath } from 'node:url';

const requiredKeys = [
  'DATABASE_URL',
  'IP_PREFIX_PEPPER',
  'RESEND_API_KEY',
  'RESEND_TEST_RECIPIENT',
  'TURNSTILE_SECRET_KEY',
] as const;
const optionalKeys = ['HOST', 'NODE_ENV', 'PORT'] as const;

export const appEnvironmentKeys = [...requiredKeys, ...optionalKeys] as const;

export class ConfigurationError extends Error {
  public readonly variableName: AppEnvironmentKey;

  public constructor(variableName: AppEnvironmentKey, reason: string) {
    super(`Invalid configuration: ${variableName} ${reason}.`);
    this.name = 'ConfigurationError';
    this.variableName = variableName;
  }
}

export function validateConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const config: AppConfig = {
    databaseUrl: databaseUrl(environment),
    host: host(environment),
    ipPrefixPepper: requiredValue(environment, 'IP_PREFIX_PEPPER'),
    nodeEnvironment: nodeEnvironment(environment),
    port: port(environment),
    resendApiKey: requiredValue(environment, 'RESEND_API_KEY'),
    resendTestRecipient: recipient(environment),
    turnstileSecretKey: requiredValue(environment, 'TURNSTILE_SECRET_KEY'),
  };
  return Object.freeze(config);
}

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  cachedConfig ??= validateConfig(process.env);
  return cachedConfig;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  getConfig();
}

function invalid(variableName: AppEnvironmentKey, reason: string): never {
  throw new ConfigurationError(variableName, reason);
}

function requiredValue(
  environment: NodeJS.ProcessEnv,
  key: RequiredEnvironmentKey,
): string {
  const value = environment[key];
  if (value === undefined || value === '') {
    return invalid(key, 'is required');
  }
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (value !== value.trim() || hasControlCharacter) {
    return invalid(
      key,
      'must not contain whitespace padding or control characters',
    );
  }
  return value;
}

function databaseUrl(environment: NodeJS.ProcessEnv): string {
  const value = requiredValue(environment, 'DATABASE_URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid('DATABASE_URL', 'must be a valid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname === '' ||
    parsed.username === '' ||
    parsed.password === '' ||
    parsed.pathname === '' ||
    parsed.pathname === '/'
  ) {
    return invalid(
      'DATABASE_URL',
      'must be a PostgreSQL URL with host, database, username, and password',
    );
  }
  return value;
}

function recipient(environment: NodeJS.ProcessEnv): string {
  const value = requiredValue(environment, 'RESEND_TEST_RECIPIENT');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
    ? value
    : invalid('RESEND_TEST_RECIPIENT', 'must be a valid email address');
}

function nodeEnvironment(environment: NodeJS.ProcessEnv): NodeEnvironment {
  const value = environment.NODE_ENV ?? 'development';
  return value === 'development' || value === 'production' || value === 'test'
    ? value
    : invalid('NODE_ENV', 'must be development, production, or test');
}

function port(environment: NodeJS.ProcessEnv): number | undefined {
  const value = environment.PORT;
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    return invalid('PORT', 'must be an integer from 1 to 65535');
  }
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 65_535
    ? parsed
    : invalid('PORT', 'must be an integer from 1 to 65535');
}

function host(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.HOST;
  if (value === undefined || value === '') {
    return undefined;
  }
  return value === value.trim() && !/\s/u.test(value)
    ? value
    : invalid('HOST', 'must be a hostname or address without whitespace');
}

type RequiredEnvironmentKey = (typeof requiredKeys)[number];
type NodeEnvironment = 'development' | 'production' | 'test';
export type AppEnvironmentKey = (typeof appEnvironmentKeys)[number];

export interface AppConfig {
  readonly databaseUrl: string;
  readonly host: string | undefined;
  readonly ipPrefixPepper: string;
  readonly nodeEnvironment: NodeEnvironment;
  readonly port: number | undefined;
  readonly resendApiKey: string;
  readonly resendTestRecipient: string;
  readonly turnstileSecretKey: string;
}
