import { resolve } from 'node:path';

import { MergeError } from '../pipeline/index.ts';
import { valueText } from '../pipeline/notes.ts';
import {
  approvalsFile,
  reviewDecisions,
  type ApprovalEntry,
  type ReviewDecision,
} from '../schema/approvals.ts';
import type { LatestFile } from '../schema/price-index-files.ts';
import { recordIdentity, type PriceRecord } from '../schema/price-record.ts';
import {
  appendApproval,
  createJsonFileStore,
  PriceStoreError,
} from '../storage/index.ts';
import {
  DataFileError,
  latestRun,
  mergeRun,
  rawRootOf,
  readDataInputs,
} from './run-files.ts';
import { formatIssues, loadConfig } from './validate.ts';

// `price-index review approve|reject --market --service --plan --actor`
// (E11.6-06). A yes or no on the one value a flagged record shows (D-028 Q1).
// It appends one decision to data/price-index/approvals.json, bound to that
// exact value and its source, and changes nothing else: the next merge
// applies it.
//
// The flagged record is read from the preview merge of the latest run
// (D-028 Q4, built by E11.6-07): the latest.json that `build-data` would
// write now from that run's observations, the founder's manual entries and
// the decisions already recorded. So the monthly routine reviews before it
// builds. With no run in the raw store at all (a fresh clone), the record is
// read from data/price-index/latest.json, as E11.6-06 built it. A newest run
// without observations was stopped before it wrote them, and must be
// resumed first. approvals.json is the same either way.

export const reviewExitCodes = {
  done: 0,
  /** A refused request: bad flags, no actor, no flagged record, not approvable. */
  refused: 1,
  /** A configuration or data file fails its schema. */
  validationFailure: 3,
} as const;

/** The command's flags, exactly; each is required and given once. */
export const reviewFlags = ['--market', '--service', '--plan', '--actor'];

export interface ReviewIo {
  root: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  clock: { now(): Date };
}

interface ReviewRequest {
  decision: ReviewDecision;
  market: string;
  service: string;
  plan: string;
  actor: string;
}

const flaggedStatuses: ReadonlySet<PriceRecord['status']> = new Set([
  'needs_review',
  'conflict',
]);

export const reviewUsage = `Usage: npm run price-index -- review approve|reject --market <code> --service <service_id> --plan <plan_id> --actor <name>
`;

/** The request, or the reason it is refused. Reads and writes nothing. */
export function parseReviewArguments(
  args: readonly string[],
): ReviewRequest | { refusal: string } {
  const [decision, ...rest] = args;
  if (!reviewDecisions.includes(decision as ReviewDecision)) {
    return { refusal: 'the first word must be approve or reject.' };
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const value = rest[index + 1];
    if (!reviewFlags.includes(flag)) {
      return { refusal: `${flag} is not a flag of review.` };
    }
    if (values.has(flag)) {
      return { refusal: `${flag} is given twice.` };
    }
    if (value === undefined || value.startsWith('--')) {
      return { refusal: `${flag} needs a value.` };
    }
    values.set(flag, value);
  }
  const actor = values.get('--actor')?.trim() ?? '';
  if (actor.length === 0) {
    return {
      refusal:
        'every decision needs --actor, the person who decides. Nothing was written.',
    };
  }
  for (const flag of reviewFlags) {
    if (!values.has(flag)) {
      return { refusal: `${flag} is required.` };
    }
  }
  return {
    decision: decision as ReviewDecision,
    market: values.get('--market')!.toUpperCase(),
    service: values.get('--service')!,
    plan: values.get('--plan')!,
    actor,
  };
}

function storeProblem(error: unknown): string | null {
  return error instanceof PriceStoreError ? error.message : null;
}

export async function runReview(
  args: readonly string[],
  io: ReviewIo,
): Promise<number> {
  const refuse = (message: string) => {
    io.stderr(`price-index review: refused: ${message}\n`);
    return reviewExitCodes.refused;
  };

  const request = parseReviewArguments(args);
  if ('refusal' in request) {
    io.stderr(
      `price-index review: refused: ${request.refusal}\n${reviewUsage}`,
    );
    return reviewExitCodes.refused;
  }

  const { config, settings, issues } = await loadConfig(io.root);
  if (config === undefined || settings === undefined || issues.length > 0) {
    io.stderr(
      `price-index review: the configuration is invalid\n${formatIssues(issues)}\n`,
    );
    return reviewExitCodes.validationFailure;
  }
  const market = config.markets.markets.find(
    (candidate) => candidate.code === request.market,
  );
  if (market === undefined) {
    return refuse(`${request.market} is not a market in config/markets.json.`);
  }
  if (!market.enabled) {
    return refuse(`${market.code} is disabled, so it has no records.`);
  }
  const service = config.catalogue.services.find(
    (candidate) => candidate.service_id === request.service,
  );
  if (service === undefined) {
    return refuse(`${request.service} is not a service in the catalogue.`);
  }
  const plan = service.plans.find(
    (candidate) => candidate.plan_id === request.plan,
  );
  if (plan === undefined) {
    return refuse(
      `${request.plan} is not a plan of ${service.service_id} in the catalogue.`,
    );
  }
  const identity = recordIdentity({
    market: market.code,
    service_id: service.service_id,
    plan_id: plan.plan_id,
    billing_period: plan.billing_period,
  });

  let latest: LatestFile | null;
  let shown: string;
  try {
    const run = await latestRun(rawRootOf(io.root));
    if (run === null) {
      shown = 'latest.json';
      latest = await createJsonFileStore({
        directory: resolve(io.root, 'data/price-index'),
      }).readLatest();
    } else if (run.observations === null) {
      return refuse(
        `run ${run.runId} has no observations yet; it was stopped before it could write them. Finish it with scrape --resume ${run.runId}, then review.`,
      );
    } else {
      shown = `the preview of run ${run.runId}`;
      latest = mergeRun({
        observations: run.observations,
        data: await readDataInputs(io.root),
        config,
        settings: settings.merge,
        clock: io.clock,
      });
    }
  } catch (error) {
    const problem =
      error instanceof DataFileError || error instanceof MergeError
        ? error.message
        : storeProblem(error);
    if (problem === null) {
      throw error;
    }
    io.stderr(`price-index review: ${problem}\n`);
    return reviewExitCodes.validationFailure;
  }
  if (latest === null) {
    return refuse(
      'there is no data/price-index/latest.json yet, so there is nothing to review.',
    );
  }
  const record = latest.records.find(
    (candidate) => recordIdentity(candidate) === identity,
  );
  if (record === undefined) {
    return refuse(`${shown} has no record for ${identity}.`);
  }
  if (!flaggedStatuses.has(record.status)) {
    return refuse(
      `${identity} is ${record.status}; only needs_review and conflict records take a decision.`,
    );
  }
  // A value that breaks a check can never be published, so no decision on
  // it is recorded (D-028 Q3 a). A manual override fills its gap instead.
  if (record.currency !== null && record.currency !== market.currency) {
    return refuse(
      `${identity} shows ${valueText(record)}, which breaks the currency check (${market.code} uses ${market.currency}). No decision can publish it; a manual override can fill the gap.`,
    );
  }
  if (record.price_local !== null && !/[1-9]/.test(record.price_local)) {
    return refuse(
      `${identity} shows ${valueText(record)}, which breaks the price check. No decision can publish it; a manual override can fill the gap.`,
    );
  }

  const entry: ApprovalEntry = {
    decision: request.decision,
    market: record.market,
    service_id: record.service_id,
    plan_id: record.plan_id,
    billing_period: record.billing_period,
    price_local: record.price_local,
    currency: record.currency,
    source: record.source,
    actor: request.actor,
    decided_at: io.clock.now().toISOString(),
  };
  try {
    await appendApproval(resolve(io.root, approvalsFile), entry);
  } catch (error) {
    const problem = storeProblem(error);
    if (problem === null) {
      throw error;
    }
    io.stderr(`price-index review: ${problem}. Nothing was written.\n`);
    return reviewExitCodes.validationFailure;
  }

  const verb = request.decision === 'approve' ? 'approved' : 'rejected';
  io.stdout(
    `price-index review: ${verb} ${valueText(record)} (${record.source}) for ${identity}, which was ${record.status} in ${shown}.\n` +
      (record.notes === null ? '' : `${record.notes}\n`) +
      `Recorded in ${approvalsFile} by ${request.actor}. The next merge applies it.\n`,
  );
  return reviewExitCodes.done;
}
