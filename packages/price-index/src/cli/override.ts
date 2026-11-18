import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  MoneyError,
  parseDecimal,
  parseMoney,
  toDecimalString,
} from '../money/index.ts';
import type { CatalogueFile, Plan, Service } from '../schema/catalogue.ts';
import {
  manualEntrySchema,
  manualOverridesFile,
  manualOverridesFileSchema,
  type ManualEntry,
  type ManualOverridesFile,
} from '../schema/manual-overrides.ts';
import type { Market, MarketsFile } from '../schema/markets.ts';
import { recordIdentity } from '../schema/price-record.ts';
import { PriceStoreError, writeManualOverrides } from '../storage/index.ts';
import type { Prompt } from './prompt.ts';
import { formatIssues, loadConfig } from './validate.ts';

// `price-index override add | not-offered | retire` (E11.6-08). The founder's
// manual entries in data/price-index/manual-overrides.json, entered by
// answering one question at a time (a script can pipe the answers in):
//
//   add          a price read on the provider's own page: market, service,
//                plan, billing period, local price, currency, an optional
//                USD figure, source_url, verified_at, verified_by and a note
//   not-offered  a confirmed `not_offered`: the same without the price,
//                currency and USD figure. The only way a plan becomes
//                `not_offered` (epic rule 6)
//   retire       removes the entry for one market, service, plan and
//                billing period
//
// Every answer is checked as it is given, and the first one that fails
// stops the command with nothing written (exit 1). In particular `add` and
// `not-offered` refuse a currency other than the market's, a source_url
// whose host is not the service's official host in the catalogue, a price
// that does not parse exactly, and an empty verified_by. The file is
// validated whole against its schema and written atomically.

export const overrideExitCodes = {
  done: 0,
  /** A refused answer or request; nothing was written. */
  refused: 1,
  /** A configuration or data file fails its schema. */
  validationFailure: 3,
} as const;

export const overrideActions = ['add', 'not-offered', 'retire'] as const;
type OverrideAction = (typeof overrideActions)[number];

export const overrideUsage = `Usage: npm run price-index -- override add|not-offered|retire
Answers the questions one line at a time; nothing is written until every answer is valid.
`;

export interface OverrideIo {
  root: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  clock: { now(): Date };
  prompt: Prompt;
}

/** An answer refused: the command stops and writes nothing. */
class Refusal extends Error {}

/** The official host of a service: its catalogue `website_url`'s host. */
export function officialHost(service: Pick<Service, 'website_url'>): string {
  return new URL(service.website_url).hostname;
}

/**
 * The reason `url` cannot be the source of a manual entry for `service`, or
 * null when it can: an https URL on the service's official host.
 */
export function sourceUrlProblem(
  url: string,
  service: Pick<Service, 'service_id' | 'website_url'>,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${JSON.stringify(url)} is not a URL.`;
  }
  if (parsed.protocol !== 'https:') {
    return `${url} is not an https URL.`;
  }
  const host = officialHost(service);
  if (parsed.hostname !== host) {
    return `${url} is not on ${host}, the official host of ${service.service_id} in config/catalogue.json.`;
  }
  return null;
}

function today(clock: { now(): Date }): string {
  return clock.now().toISOString().slice(0, 10);
}

/** A real calendar date, `YYYY-MM-DD`, no later than `latest`. */
function dateProblem(value: string, latest: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return `${JSON.stringify(value)} is not a date written YYYY-MM-DD.`;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    return `${value} is not a calendar date.`;
  }
  if (value > latest) {
    return `${value} is in the future; verified_at is the day the page was read.`;
  }
  return null;
}

interface Target {
  market: Market;
  service: Service;
  plan: Plan;
}

class Questions {
  constructor(private readonly prompt: Prompt) {}

  async answer(question: string): Promise<string> {
    const line = await this.prompt.ask(question);
    if (line === null) {
      throw new Refusal('the input ended before every question was answered.');
    }
    return line.trim();
  }

  /** Market, service, plan and billing period, each checked against the config. */
  async target(markets: MarketsFile, catalogue: CatalogueFile) {
    const code = (
      await this.answer('Market (ISO code, e.g. SE): ')
    ).toUpperCase();
    const market = markets.markets.find((candidate) => candidate.code === code);
    if (market === undefined) {
      throw new Refusal(
        `${code || '(empty)'} is not a market in config/markets.json.`,
      );
    }
    if (!market.enabled) {
      throw new Refusal(`${market.code} is disabled, so it has no records.`);
    }
    const serviceId = await this.answer('Service (service_id): ');
    const service = catalogue.services.find(
      (candidate) => candidate.service_id === serviceId,
    );
    if (service === undefined) {
      throw new Refusal(
        `${serviceId || '(empty)'} is not a service in the catalogue.`,
      );
    }
    const planId = await this.answer(
      `Plan (${service.plans.map((plan) => plan.plan_id).join(', ')}): `,
    );
    const plan = service.plans.find(
      (candidate) => candidate.plan_id === planId,
    );
    if (plan === undefined) {
      throw new Refusal(
        `${planId || '(empty)'} is not a plan of ${service.service_id} in the catalogue.`,
      );
    }
    const period =
      (await this.answer(`Billing period [${plan.billing_period}]: `)) ||
      plan.billing_period;
    if (period !== plan.billing_period) {
      throw new Refusal(
        `${service.service_id} ${plan.plan_id} is tracked per ${plan.billing_period}, not ${period}.`,
      );
    }
    return { market, service, plan } satisfies Target;
  }

  async verification(target: Target, clock: { now(): Date }) {
    const sourceUrl = await this.answer(
      `Source URL (on ${officialHost(target.service)}): `,
    );
    const urlProblem = sourceUrlProblem(sourceUrl, target.service);
    if (urlProblem !== null) {
      throw new Refusal(urlProblem);
    }
    const now = today(clock);
    const verifiedAt =
      (await this.answer(`Verified at (YYYY-MM-DD) [${now}]: `)) || now;
    const date = dateProblem(verifiedAt, now);
    if (date !== null) {
      throw new Refusal(date);
    }
    const verifiedBy = await this.answer('Verified by: ');
    if (verifiedBy.length === 0) {
      throw new Refusal(
        'verified_by is empty; every manual entry names who checked it.',
      );
    }
    const note = await this.answer('Note (optional): ');
    return {
      source_url: sourceUrl,
      verified_at: verifiedAt,
      verified_by: verifiedBy,
      note: note.length === 0 ? null : note,
    };
  }

  /** The local price, its currency and the optional USD figure, all exact. */
  async price(market: Market) {
    const priceText = await this.answer(
      'Local price, as the official page shows it (e.g. 149 or 149,00 kr): ',
    );
    const currency =
      (await this.answer(`Currency [${market.currency}]: `)).toUpperCase() ||
      market.currency;
    if (currency !== market.currency) {
      throw new Refusal(
        `${currency} is not ${market.code}'s currency; ${market.code} uses ${market.currency}.`,
      );
    }
    let priceLocal: string;
    try {
      priceLocal = toDecimalString(parseMoney(priceText, { currency }).money);
    } catch (error) {
      if (error instanceof MoneyError) {
        throw new Refusal(
          `the price ${JSON.stringify(priceText)} does not parse exactly in ${currency}: ${error.message}.`,
        );
      }
      throw error;
    }
    if (!/[1-9]/u.test(priceLocal)) {
      throw new Refusal('the price must be above zero.');
    }
    const usdText = await this.answer('USD figure (optional, e.g. 14.80): ');
    let usd: string | null = null;
    if (usdText.length > 0) {
      try {
        usd = toDecimalString(parseDecimal(usdText, 'USD'));
      } catch (error) {
        if (error instanceof MoneyError) {
          throw new Refusal(
            `the USD figure ${JSON.stringify(usdText)} does not parse exactly: ${error.message}.`,
          );
        }
        throw error;
      }
      if (!/[1-9]/u.test(usd)) {
        throw new Refusal('the USD figure must be above zero.');
      }
    }
    return { price_local: priceLocal, currency, price_usd_source: usd };
  }
}

async function readOverrides(root: string): Promise<ManualOverridesFile> {
  const file = manualOverridesFile;
  let text: string;
  try {
    text = await readFile(resolve(root, file), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PriceStoreError(
      'invalid_data',
      `${file}: ${code === 'ENOENT' ? 'file not found' : `unreadable (${code})`}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PriceStoreError(
      'not_json',
      `${file}: not valid JSON: ${(error as Error).message}`,
    );
  }
  const result = manualOverridesFileSchema.safeParse(value);
  if (!result.success) {
    throw new PriceStoreError(
      'invalid_data',
      `${file}: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

function describe(entry: ManualEntry): string {
  const what =
    entry.kind === 'price'
      ? `${entry.price_local} ${entry.currency}`
      : 'not offered';
  return `${recordIdentity(entry)}: ${what}, verified ${entry.verified_at} by ${entry.verified_by} (${entry.source_url})`;
}

export async function runOverride(
  args: readonly string[],
  io: OverrideIo,
): Promise<number> {
  const [action, ...rest] = args;
  if (!overrideActions.includes(action as OverrideAction) || rest.length > 0) {
    io.stderr(
      `price-index override: refused: the command is override add, override not-offered or override retire, with no flags.\n${overrideUsage}`,
    );
    return overrideExitCodes.refused;
  }

  const { config, issues } = await loadConfig(io.root);
  if (config === undefined || issues.length > 0) {
    io.stderr(
      `price-index override: the configuration is invalid\n${formatIssues(issues)}\n`,
    );
    return overrideExitCodes.validationFailure;
  }
  let current: ManualOverridesFile;
  try {
    current = await readOverrides(io.root);
  } catch (error) {
    if (error instanceof PriceStoreError) {
      io.stderr(`price-index override: ${error.message}\n`);
      return overrideExitCodes.validationFailure;
    }
    throw error;
  }

  const questions = new Questions(io.prompt);
  let next: ManualOverridesFile;
  let done: string;
  try {
    const target = await questions.target(config.markets, config.catalogue);
    const identity = recordIdentity({
      market: target.market.code,
      service_id: target.service.service_id,
      plan_id: target.plan.plan_id,
      billing_period: target.plan.billing_period,
    });
    const existing = current.overrides.find(
      (entry) => recordIdentity(entry) === identity,
    );

    if (action === 'retire') {
      if (existing === undefined) {
        throw new Refusal(`there is no manual entry for ${identity}.`);
      }
      next = {
        overrides: current.overrides.filter((entry) => entry !== existing),
      };
      done = `retired ${describe(existing)}`;
    } else {
      if (existing !== undefined) {
        throw new Refusal(
          `there is already a manual entry for ${identity} (${describe(existing)}). Retire it first.`,
        );
      }
      const identityFields = {
        market: target.market.code,
        service_id: target.service.service_id,
        plan_id: target.plan.plan_id,
        billing_period: target.plan.billing_period,
      };
      const candidate =
        action === 'add'
          ? {
              kind: 'price' as const,
              ...identityFields,
              ...(await questions.price(target.market)),
              ...(await questions.verification(target, io.clock)),
            }
          : {
              kind: 'not_offered' as const,
              ...identityFields,
              ...(await questions.verification(target, io.clock)),
            };
      const checked = manualEntrySchema.safeParse(candidate);
      if (!checked.success) {
        throw new Refusal(
          checked.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
        );
      }
      next = { overrides: [...current.overrides, checked.data] };
      done = `${action === 'add' ? 'added' : 'recorded'} ${describe(checked.data)}`;
    }
  } catch (error) {
    if (error instanceof Refusal) {
      io.stderr(
        `\nprice-index override ${action}: refused: ${error.message}\nNothing was written.\n`,
      );
      return overrideExitCodes.refused;
    }
    throw error;
  } finally {
    io.prompt.close();
  }

  try {
    await writeManualOverrides(resolve(io.root, manualOverridesFile), next);
  } catch (error) {
    if (error instanceof PriceStoreError) {
      io.stderr(
        `\nprice-index override ${action}: refused: ${error.message}\nNothing was written.\n`,
      );
      return overrideExitCodes.validationFailure;
    }
    throw error;
  }
  io.stdout(
    `\nprice-index override ${action}: ${done}.\nWritten to ${manualOverridesFile}. The next merge (scrape's preview, or build-data) applies it.\n`,
  );
  return overrideExitCodes.done;
}
