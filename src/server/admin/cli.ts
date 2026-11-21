import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// E11.7-02: the founder command line (`npm run admin -- <command>`).
//
// It calls the admin API over HTTP with the secret key and a freshly typed
// authenticator code, exactly as any other admin client does, so every action
// passes the E5-03a boundary and is audited by the route it calls. It never
// connects to the database, and it never writes the key, the code or any
// response to disk: the key comes from the environment or a hidden prompt, the
// code from a prompt on every run. Later tickets add their commands to
// `adminCommands`.

export const defaultAdminApiOrigin = 'https://valstara.com';
const requestTimeoutMilliseconds = 30_000;
const authenticatorCode = /^\d{6}$/u;

export interface AdminCommandIo {
  /** Ask for one line. Hidden input is not echoed on a terminal. */
  prompt(
    question: string,
    options: { readonly hidden: boolean },
  ): Promise<string>;
  write(line: string): void;
}

export interface AdminCommandEnvironment {
  readonly ADMIN_API_ORIGIN?: string | undefined;
  readonly ADMIN_CREDENTIAL?: string | undefined;
}

interface AdminRequest {
  readonly method: 'POST';
  readonly path: string;
  readonly body: Record<string, unknown>;
}

interface AdminCommand {
  readonly usage: string;
  build(args: readonly string[]): AdminRequest;
  describe(body: Record<string, unknown>): readonly string[];
}

export class AdminCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AdminCommandError';
  }
}

function usageText(): string {
  return [
    'Usage: npm run admin -- <command>',
    ...Object.values(adminCommands).map((command) => `  ${command.usage}`),
    '',
    'The secret key is read from ADMIN_CREDENTIAL or asked for without echo.',
    'The authenticator code is asked for on every run.',
    `The API origin is ADMIN_API_ORIGIN, or ${defaultAdminApiOrigin}.`,
  ].join('\n');
}

function usageError(message: string): AdminCommandError {
  return new AdminCommandError(`${message}\n${usageText()}`);
}

function readReason(args: readonly string[]): {
  positional: readonly string[];
  reason: string;
} {
  const index = args.indexOf('--reason');
  const reason = index === -1 ? undefined : args[index + 1];
  if (reason === undefined || reason.trim() === '' || reason.startsWith('--')) {
    throw usageError('A reason is required: --reason "<why>".');
  }
  return {
    positional: [...args.slice(0, index), ...args.slice(index + 2)],
    reason,
  };
}

function referralVoidCommand(operation: 'unvoid' | 'void'): AdminCommand {
  return {
    usage: `referrals ${operation} <subscriber-id> --reason "<why>"`,
    build(args) {
      const { positional, reason } = readReason(args);
      if (positional.length !== 1 || positional[0]?.startsWith('--')) {
        throw usageError(
          'Name the referred subscriber whose referral to change.',
        );
      }
      return {
        method: 'POST',
        path: `/api/admin/referrals/${operation}`,
        body: { subscriber_id: positional[0], reason },
      };
    },
    describe(body) {
      const referral = record(body.referral);
      const referrer = record(body.referrer);
      return [
        `Referral of ${String(referral.referred_id)} is now ${
          referral.voided === true ? 'voided' : 'not voided'
        }.`,
        `Referrer ${String(referral.referrer_id)} has ${String(
          referrer.confirmed_referrals,
        )} confirmed referrals.`,
        `Giveaway entry: ${String(body.giveaway_entry)}.`,
      ];
    },
  };
}

export const adminCommands: Readonly<Record<string, AdminCommand>> = {
  'referrals void': referralVoidCommand('void'),
  'referrals unvoid': referralVoidCommand('unvoid'),
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The API origin, refused unless it is HTTPS or plain HTTP on loopback. */
export function adminApiOrigin(environment: AdminCommandEnvironment): URL {
  const raw = environment.ADMIN_API_ORIGIN ?? defaultAdminApiOrigin;
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new AdminCommandError('ADMIN_API_ORIGIN is not a valid URL.');
  }
  const secure =
    origin.protocol === 'https:' ||
    (origin.protocol === 'http:' && loopbackHosts.has(origin.hostname));
  if (
    !secure ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  ) {
    throw new AdminCommandError(
      'ADMIN_API_ORIGIN must be a bare HTTPS origin, or HTTP on this machine.',
    );
  }
  return origin;
}

export async function runAdminCommand(
  args: readonly string[],
  environment: AdminCommandEnvironment,
  io: AdminCommandIo,
  request: typeof fetch = fetch,
): Promise<void> {
  const name = args.slice(0, 2).join(' ');
  const command = adminCommands[name];
  if (command === undefined) throw usageError('Unknown command.');
  const adminRequest = command.build(args.slice(2));
  const origin = adminApiOrigin(environment);

  const credential =
    environment.ADMIN_CREDENTIAL ??
    (await io.prompt('Secret key: ', { hidden: true }));
  if (credential.trim() === '') {
    throw new AdminCommandError('The secret key is required.');
  }
  const code = (
    await io.prompt('Authenticator code: ', { hidden: true })
  ).trim();
  if (!authenticatorCode.test(code)) {
    throw new AdminCommandError(
      'A six-digit authenticator code is required. Nothing was sent.',
    );
  }

  let response: Response;
  try {
    response = await request(new URL(adminRequest.path, origin), {
      method: adminRequest.method,
      headers: {
        Authorization: `Bearer ${credential.trim()}`,
        'Content-Type': 'application/json',
        'X-Valstara-TOTP': code,
      },
      body: JSON.stringify(adminRequest.body),
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    });
  } catch {
    throw new AdminCommandError('The admin API could not be reached.');
  }

  let body: Record<string, unknown>;
  try {
    body = record(await response.json());
  } catch {
    throw new AdminCommandError(
      `The admin API returned an unexpected response (HTTP ${response.status}).`,
    );
  }
  if (!response.ok) {
    const error = record(body.error);
    throw new AdminCommandError(
      `${String(error.code ?? 'internal')}: ${String(
        error.message ?? 'The request failed.',
      )}`,
    );
  }
  for (const line of command.describe(body)) io.write(line);
}

/** Prompts on stderr; reads lines when piped, or raw keys without echo. */
function createProcessIo(): AdminCommandIo & { close(): void } {
  const input = process.stdin;
  // Created on the first piped prompt only, and closed at the end, so a run
  // that refuses before prompting never holds stdin open.
  let reader: ReturnType<typeof createInterface> | null = null;
  let lines: AsyncIterator<string> | null = null;

  function readWithoutEcho(): Promise<string> {
    return new Promise((resolve, reject) => {
      let value = '';
      const finish = () => {
        input.off('data', onData);
        input.setRawMode(false);
        input.pause();
        process.stderr.write('\n');
      };
      const onData = (chunk: Buffer) => {
        for (const character of chunk.toString('utf8')) {
          if (character === '\r' || character === '\n') {
            finish();
            resolve(value);
            return;
          }
          if (character === '\u0003') {
            finish();
            reject(new AdminCommandError('Cancelled. Nothing was sent.'));
            return;
          }
          value =
            character === '\u007f' || character === '\b'
              ? value.slice(0, -1)
              : value + character;
        }
      };
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
    });
  }

  return {
    async prompt(question) {
      process.stderr.write(question);
      if (input.isTTY) return readWithoutEcho();
      if (lines === null) {
        reader = createInterface({ input, terminal: false });
        lines = reader[Symbol.asyncIterator]();
      }
      const next = await lines.next();
      if (next.done === true) {
        process.stderr.write('\n');
        return '';
      }
      return next.value;
    },
    write(line) {
      process.stdout.write(`${line}\n`);
    },
    close() {
      reader?.close();
      input.pause();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const io = createProcessIo();
  try {
    await runAdminCommand(
      process.argv.slice(2),
      {
        ADMIN_API_ORIGIN: process.env.ADMIN_API_ORIGIN,
        ADMIN_CREDENTIAL: process.env.ADMIN_CREDENTIAL,
      },
      io,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof AdminCommandError ? error.message : 'The admin command failed.'}\n`,
    );
    process.exitCode = 1;
  } finally {
    io.close();
  }
}
