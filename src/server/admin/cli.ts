import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// E11.7-02: the founder command line (`npm run admin -- <command>`).
//
// It calls the admin API over HTTP with the secret key and a freshly typed
// authenticator code, exactly as any other admin client does, so every action
// passes the E5-03a boundary and is audited by the route it calls. It never
// connects to the database, and it never writes the key, the code or any
// response to disk: the key comes from the environment or a hidden prompt, the
// code from a prompt on every run. Responses go to standard output; the
// partners export (E11.7-06) streams its review CSV there for the founder to
// redirect. Later tickets add their commands to `adminCommands`.

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
  /** Write a streamed response body as it arrives, unchanged (a CSV export). */
  writeChunk(text: string): void;
}

export interface AdminCommandEnvironment {
  readonly ADMIN_API_ORIGIN?: string | undefined;
  readonly ADMIN_CREDENTIAL?: string | undefined;
}

type AdminRequest =
  | {
      readonly method: 'POST';
      readonly path: string;
      readonly body: Record<string, unknown>;
    }
  | {
      readonly method: 'GET';
      readonly path: string;
      readonly query?: Readonly<Record<string, string>>;
    };

interface AdminCommand {
  readonly usage: string;
  build(args: readonly string[]): AdminRequest;
  /** Lines for a JSON response; a command without it streams the body. */
  describe?(body: Record<string, unknown>): readonly string[];
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

/**
 * Splits `args` into positional values and `--options`. Value options take
 * the next argument; flags take none. An unknown, repeated or empty option is
 * refused, so a typo never silently drops a filter.
 */
function readOptions(
  args: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[] = [],
): {
  positional: readonly string[];
  values: Readonly<Record<string, string>>;
  flags: ReadonlySet<string>;
} {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    if (argument in values || flags.has(argument)) {
      throw usageError(`${argument} is given more than once.`);
    }
    if (flagOptions.includes(argument)) {
      flags.add(argument);
      continue;
    }
    if (!valueOptions.includes(argument)) {
      throw usageError(`Unknown option ${argument}.`);
    }
    const value = args[index + 1];
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      throw usageError(`${argument} needs a value.`);
    }
    values[argument] = value;
    index += 1;
  }
  return { positional, values, flags };
}

function onePartnerId(positional: readonly string[]): string {
  if (positional.length !== 1 || positional[0] === undefined) {
    throw usageError('Name one partner by its id.');
  }
  return encodeURIComponent(positional[0]);
}

function describeTransition(body: Record<string, unknown>): readonly string[] {
  const partner = record(body.partner);
  const before = record(partner.before);
  const after = record(partner.after);
  const lines = [
    `Partner ${String(partner.id)}: ${String(before.status)} -> ${String(
      after.status,
    )}.`,
  ];
  if (after.code !== null && after.code !== undefined) {
    lines.push(
      `Code: ${String(after.code)} (${after.code_active === true ? 'live' : 'not live'}).`,
    );
  }
  if (body.mail_queued !== null && body.mail_queued !== undefined) {
    lines.push(`Email queued: ${body.mail_queued === true ? 'yes' : 'no'}.`);
  }
  return lines;
}

/** A partner command that takes only the partner's id. */
function partnerStatusCommand(
  verb: 'contract-sent' | 'pause' | 'reactivate' | 'terminate',
): AdminCommand {
  return {
    usage: `partners ${verb} <partner-id>`,
    build(args) {
      const { positional } = readOptions(args, []);
      return {
        method: 'POST',
        path: `/api/admin/partners/${onePartnerId(positional)}/${verb}`,
        body: {},
      };
    },
    describe: describeTransition,
  };
}

const partnerCommands: Readonly<Record<string, AdminCommand>> = {
  'partners list': {
    usage:
      'partners list [--status <status>] [--type <type>] [--since YYYY-MM-DD] [--stale] [--after <partner-id>]',
    build(args) {
      const { positional, values, flags } = readOptions(
        args,
        ['--status', '--type', '--since', '--after'],
        ['--stale'],
      );
      if (positional.length !== 0) throw usageError('Unexpected argument.');
      const query: Record<string, string> = {};
      for (const [option, value] of Object.entries(values)) {
        query[option.slice(2)] = value;
      }
      if (flags.has('--stale')) query.stale = 'true';
      return { method: 'GET', path: '/api/admin/partners', query };
    },
    describe(body) {
      const partners = Array.isArray(body.partners) ? body.partners : [];
      const lines = partners.map((value) => {
        const row = record(value);
        return [
          String(row.id),
          String(row.status),
          String(row.partner_type),
          String(row.code ?? row.requested_code ?? '-'),
          String(row.full_name ?? '-'),
          String(row.email ?? '-'),
          `applied ${String(row.applied_at)}`,
          row.stale === true ? 'STALE' : '',
        ]
          .filter((part) => part !== '')
          .join('  ');
      });
      lines.push(`${partners.length} partners.`);
      if (typeof body.next_after === 'string') {
        lines.push(`More: add --after ${body.next_after}`);
      }
      return lines;
    },
  },
  'partners show': {
    usage: 'partners show <partner-id>',
    build(args) {
      const { positional } = readOptions(args, []);
      return {
        method: 'GET',
        path: `/api/admin/partners/${onePartnerId(positional)}`,
      };
    },
    describe(body) {
      const partner = record(body.partner);
      const referrals = record(body.referrals);
      const lines = Object.entries(partner).map(
        ([key, value]) =>
          `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`,
      );
      lines.push(
        `referrals: ${String(referrals.confirmed)} confirmed, ${String(
          referrals.pending,
        )} pending, ${String(referrals.voided)} voided, ${String(
          referrals.flagged,
        )} flagged`,
        `last_activity_at: ${String(referrals.last_activity_at)}`,
      );
      const flagged = Array.isArray(body.flagged_referrals)
        ? body.flagged_referrals
        : [];
      for (const value of flagged) {
        const referral = record(value);
        const kinds = Array.isArray(referral.flag_kinds)
          ? referral.flag_kinds.join(', ')
          : '';
        lines.push(
          `flagged: ${String(referral.referred_id)} ${String(referral.state)}${
            referral.voided === true ? ' voided' : ''
          } (${kinds})`,
        );
      }
      return lines;
    },
  },
  'partners approve': {
    usage: 'partners approve <partner-id> [--code <CODE>]',
    build(args) {
      const { positional, values } = readOptions(args, ['--code']);
      const code = values['--code'];
      return {
        method: 'POST',
        path: `/api/admin/partners/${onePartnerId(positional)}/approve`,
        body: code === undefined ? {} : { code },
      };
    },
    describe: describeTransition,
  },
  'partners reject': {
    usage: 'partners reject <partner-id> [--template]',
    build(args) {
      const { positional, flags } = readOptions(args, [], ['--template']);
      return {
        method: 'POST',
        path: `/api/admin/partners/${onePartnerId(positional)}/reject`,
        body: flags.has('--template') ? { template: true } : {},
      };
    },
    describe: describeTransition,
  },
  'partners contract-sent': partnerStatusCommand('contract-sent'),
  'partners contract-signed': {
    usage:
      'partners contract-signed <partner-id> --date YYYY-MM-DD --version <version> [--reference "<signfree reference>"]',
    build(args) {
      const { positional, values } = readOptions(args, [
        '--date',
        '--version',
        '--reference',
      ]);
      const date = values['--date'];
      const version = values['--version'];
      if (date === undefined || version === undefined) {
        throw usageError('A signed contract needs --date and --version.');
      }
      const reference = values['--reference'];
      return {
        method: 'POST',
        path: `/api/admin/partners/${onePartnerId(positional)}/contract-signed`,
        body:
          reference === undefined
            ? { date, version }
            : { date, version, reference },
      };
    },
    describe: describeTransition,
  },
  'partners pause': partnerStatusCommand('pause'),
  'partners terminate': partnerStatusCommand('terminate'),
  'partners reactivate': partnerStatusCommand('reactivate'),
  'partners set-type': {
    usage:
      'partners set-type <partner-id> <standard|student_ambassador|creator> [--university "<name>"]',
    build(args) {
      const { positional, values } = readOptions(args, ['--university']);
      if (positional.length !== 2 || positional[1] === undefined) {
        throw usageError('Name the partner and its new type.');
      }
      const university = values['--university'];
      return {
        method: 'POST',
        path: `/api/admin/partners/${onePartnerId(positional.slice(0, 1))}/type`,
        body:
          university === undefined
            ? { type: positional[1] }
            : { type: positional[1], university },
      };
    },
    describe(body) {
      const partner = record(body.partner);
      return [
        `Partner ${String(partner.id)} is now ${String(
          record(partner.after).partner_type,
        )}.`,
      ];
    },
  },
  'partners note': {
    usage: 'partners note <partner-id> --text "<notes>"',
    build(args) {
      const { positional, values } = readOptions(args, ['--text']);
      const text = values['--text'];
      if (text === undefined) throw usageError('Notes need --text.');
      return {
        method: 'POST',
        path: `/api/admin/partners/${onePartnerId(positional)}/note`,
        body: { text },
      };
    },
    describe(body) {
      return [`Notes replaced for partner ${String(record(body.partner).id)}.`];
    },
  },
  // Streams the CSV to standard output, unchanged; redirect it to a file:
  // `npm run --silent admin -- partners export > partners.csv`.
  'partners export': {
    usage: 'partners export',
    build(args) {
      const { positional } = readOptions(args, []);
      if (positional.length !== 0) throw usageError('Unexpected argument.');
      return { method: 'GET', path: '/api/admin/partners/export.csv' };
    },
  },
  'partners sync-brevo': {
    usage: 'partners sync-brevo',
    build(args) {
      const { positional } = readOptions(args, []);
      if (positional.length !== 0) throw usageError('Unexpected argument.');
      return {
        method: 'POST',
        path: '/api/admin/partners/sync-brevo',
        body: {},
      };
    },
    describe(body) {
      const sync = record(body.sync);
      if (sync.state === 'disabled') return ['Partner sync to Brevo is off.'];
      return [
        `Partner sync to Brevo: ${String(sync.selected)} checked, ${String(sync.upserted)} updated, ${String(sync.removed)} removed.`,
      ];
    },
  },
};

export const adminCommands: Readonly<Record<string, AdminCommand>> = {
  'referrals void': referralVoidCommand('void'),
  'referrals unvoid': referralVoidCommand('unvoid'),
  ...partnerCommands,
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

  const target = new URL(adminRequest.path, origin);
  if (adminRequest.method === 'GET') {
    for (const [key, value] of Object.entries(adminRequest.query ?? {})) {
      target.searchParams.set(key, value);
    }
  }
  let response: Response;
  try {
    response = await request(target, {
      method: adminRequest.method,
      headers: {
        Authorization: `Bearer ${credential.trim()}`,
        ...(adminRequest.method === 'POST'
          ? { 'Content-Type': 'application/json' }
          : {}),
        'X-Valstara-TOTP': code,
      },
      ...(adminRequest.method === 'POST'
        ? { body: JSON.stringify(adminRequest.body) }
        : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    });
  } catch {
    throw new AdminCommandError('The admin API could not be reached.');
  }

  if (command.describe === undefined && response.ok) {
    // A streamed export: written as it arrives, never buffered whole and
    // never written to disk by this command.
    if (response.body === null) {
      throw new AdminCommandError('The admin API returned an empty response.');
    }
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) {
        io.writeChunk(decoder.decode(chunk, { stream: true }));
      }
      io.writeChunk(decoder.decode());
    } catch {
      throw new AdminCommandError('The export stopped before it finished.');
    }
    return;
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
  for (const line of command.describe?.(body) ?? []) io.write(line);
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
    writeChunk(text) {
      process.stdout.write(text);
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
