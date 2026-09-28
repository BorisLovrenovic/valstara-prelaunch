import { getConfig, getP1AlertConfiguration } from '../src/server/config.ts';
import { createPool } from '../src/server/db/pool.ts';
import { createUnsubscribeService } from '../src/server/email/unsubscribe.ts';
import { createUnsubscribeOperatorTaskTransport } from '../src/server/verification-rate/p1-webhook.ts';

export interface ApplyUnsubscribeCliInput {
  readonly tokenId?: string;
  readonly tokenSha256?: string;
  readonly actor: string;
  readonly action?: 'leave_waitlist';
}

export function parseApplyUnsubscribeArgs(
  args: readonly string[],
): ApplyUnsubscribeCliInput {
  const usage =
    'Usage: npm run email:apply-unsubscribe -- (--token-id <id> | --token-sha256 <hex>) --actor <name> [--action leave_waitlist]';
  if (args.length % 2 !== 0) throw new Error(usage);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (
      !['--token-id', '--token-sha256', '--actor', '--action'].includes(key) ||
      values.has(key)
    )
      throw new Error(usage);
    values.set(key, value);
  }
  const tokenId = values.get('--token-id');
  const tokenSha256 = values.get('--token-sha256');
  const actor = values.get('--actor');
  const action = values.get('--action');
  if (
    (tokenId === undefined) === (tokenSha256 === undefined) ||
    (tokenId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        tokenId,
      )) ||
    (tokenSha256 !== undefined && !/^[0-9a-f]{64}$/iu.test(tokenSha256)) ||
    !/^[\p{L}\p{N} ._'-]{2,80}$/u.test(actor ?? '') ||
    actor?.trim() === '' ||
    (action !== undefined && action !== 'leave_waitlist')
  )
    throw new Error(usage);
  return {
    tokenId,
    tokenSha256,
    actor: actor!,
    action: action as 'leave_waitlist' | undefined,
  };
}

export async function applyUnsubscribeFromCli(
  input: ApplyUnsubscribeCliInput,
  dependencies: {
    readonly applyById: ReturnType<
      typeof createUnsubscribeService
    >['applyById'];
    readonly applyByHash: ReturnType<
      typeof createUnsubscribeService
    >['applyByHash'];
  },
): Promise<'applied' | 'already' | 'invalid'> {
  const result =
    input.tokenId !== undefined
      ? await dependencies.applyById({
          unsubscribeTokenId: input.tokenId,
          actor: input.actor,
          action: input.action,
          ipPrefixHash: 'operator',
        })
      : await dependencies.applyByHash({
          tokenSha256: input.tokenSha256!,
          actor: input.actor,
          action: input.action,
          ipPrefixHash: 'operator',
        });
  if (result === 'rate_limited')
    throw new Error('Operator unsubscribe rate limit reached.');
  return result === 'accepted' ? 'applied' : result;
}

if (process.argv[1]?.endsWith('/apply-unsubscribe.ts')) {
  const args = parseApplyUnsubscribeArgs(process.argv.slice(2));
  const config = getConfig();
  const database = createPool(config.databaseUrl);
  try {
    const alerts = createUnsubscribeOperatorTaskTransport(
      getP1AlertConfiguration(),
    );
    const service = createUnsubscribeService(database, {
      tokenSecret: config.emailTokenSecret,
      onFailure: ({
        unsubscribeTokenId,
        emailSendId,
        tokenSha256,
        requestedAction,
        occurredAt,
      }) =>
        alerts.send({
          kind: 'operator_task',
          task: 'unsubscribe_apply_failed',
          unsubscribe_token_id: unsubscribeTokenId,
          email_send_id: emailSendId,
          token_sha256: tokenSha256,
          requested_action: requestedAction,
          occurred_at: occurredAt.toISOString(),
        }),
    });
    const result = await applyUnsubscribeFromCli(args, service);
    process.stdout.write(`${result}\n`);
  } finally {
    await database.close();
  }
}
