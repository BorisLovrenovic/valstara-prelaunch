import { z } from 'zod';

import { billingPeriods } from './catalogue.ts';
import { currencySchema, slugSchema } from './common.ts';
import { iso4217Currencies, minorUnitExponent } from './iso4217.ts';
import { isDecimalAtExponent, recordSourcePattern } from './price-record.ts';

// data/price-index/approvals.json (E11.6-06): the founder's decisions on
// `needs_review` and `conflict` records, written by `price-index review`.
// **Append-only** (epic rule 7): CI fails a change that edits, removes or
// reorders an entry (`scripts/ci/price-index-append-only.mjs`).
//
// A decision is a yes or no on the one value a record showed (D-028 Q1). It
// binds to the market, service, plan, billing period, `price_local`,
// `currency` and `source`; any other value needs a new decision, and the
// last decision for a value counts. A disappearance shows no price, so its
// decision binds to a null `price_local` and `currency`.

export const approvalsFile = 'data/price-index/approvals.json';

export const reviewDecisions = ['approve', 'reject'] as const;

export const approvalEntrySchema = z
  .strictObject({
    decision: z.enum(reviewDecisions),
    market: z
      .string()
      .regex(/^[A-Z]{2}$/, { error: 'must be an ISO 3166-1 alpha-2 code' }),
    service_id: slugSchema,
    plan_id: slugSchema,
    billing_period: z.enum(billingPeriods),
    price_local: z.string().nullable(),
    currency: currencySchema.nullable(),
    source: z.string().regex(recordSourcePattern, {
      error: 'must be scraper:youfundceo.com, manual or direct:<provider>',
    }),
    /** Who decided. A decision without one is never written. */
    actor: z
      .string()
      .refine((value) => value.trim().length > 0 && value.trim() === value, {
        error: 'must be non-empty, with no leading or trailing whitespace',
      }),
    decided_at: z.iso.datetime(),
  })
  .superRefine((entry, context) => {
    if ((entry.price_local === null) !== (entry.currency === null)) {
      context.addIssue({
        code: 'custom',
        message: 'price_local and currency are both set or both null',
        path: ['currency'],
      });
    }
    if (
      entry.price_local !== null &&
      entry.currency !== null &&
      iso4217Currencies.has(entry.currency) &&
      !isDecimalAtExponent(entry.price_local, entry.currency)
    ) {
      context.addIssue({
        code: 'custom',
        message: `must be written at the minor-unit exponent of ${entry.currency} (${minorUnitExponent(entry.currency)} decimals)`,
        path: ['price_local'],
      });
    }
  });

export const approvalsFileSchema = z.strictObject({
  approvals: z.array(approvalEntrySchema),
});

/** The keys of an entry, in the order the file writes them. */
export const approvalEntryKeys = [
  'decision',
  'market',
  'service_id',
  'plan_id',
  'billing_period',
  'price_local',
  'currency',
  'source',
  'actor',
  'decided_at',
] as const;

export type ApprovalEntry = z.infer<typeof approvalEntrySchema>;
export type ApprovalsFile = z.infer<typeof approvalsFileSchema>;
export type ReviewDecision = (typeof reviewDecisions)[number];
