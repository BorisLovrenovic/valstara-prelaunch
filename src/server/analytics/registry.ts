/**
 * Analytics accepts categories, never caller-provided identifiers or raw UTM
 * values. A new server property must declare a finite set of values here.
 * The six public-context fields belong only to E10-01's client page emitter.
 */
const category = <const Values extends readonly string[]>(...allowed: Values) =>
  Object.freeze({ kind: 'category' as const, allowed: Object.freeze(allowed) });
const boolean = Object.freeze({ kind: 'boolean' as const });
const publicContext = Object.freeze({ kind: 'public_context' as const });

export const eventRegistry = Object.freeze({
  page_view: Object.freeze({
    source: 'client' as const,
    properties: Object.freeze({
      website: publicContext,
      hostname: publicContext,
      url: publicContext,
      referrer: publicContext,
      title: publicContext,
      language: publicContext,
    }),
  }),
  signup_submitted: Object.freeze({
    source: 'server' as const,
    properties: Object.freeze({
      source_bucket: category(
        'direct',
        'referral',
        'email',
        'social',
        'paid',
        'organic',
        'other',
      ),
      had_ref: boolean,
      marketing_opt_in: boolean,
    }),
  }),
  signup_rejected: Object.freeze({
    source: 'server' as const,
    properties: Object.freeze({
      reason_code: category(
        'invalid_input',
        'invalid_email',
        'blocked_domain',
        'challenge_failed',
        'rate_limited',
        'unavailable',
        'internal',
      ),
    }),
  }),
  verified: Object.freeze({
    source: 'server' as const,
    properties: Object.freeze({
      hours_to_verify_bucket: category(
        'under_1',
        '1_to_24',
        '24_to_72',
        'over_72',
      ),
      source_bucket: category(
        'direct',
        'referral',
        'email',
        'social',
        'paid',
        'organic',
        'other',
      ),
    }),
  }),
  referral_confirmed: Object.freeze({
    source: 'server' as const,
    properties: Object.freeze({
      referrer_tier_bucket: category('none', 'tier_1', 'tier_2_or_higher'),
    }),
  }),
  survey_completed: Object.freeze({
    source: 'server' as const,
    properties: Object.freeze({
      question_set_version: category('2026-09-08'),
    }),
  }),
  giveaway_entered: Object.freeze({
    source: 'server' as const,
    properties: Object.freeze({ method: category('base', 'referral') }),
  }),
  unsubscribed: Object.freeze({
    source: 'server' as const,
    properties: Object.freeze({
      source_template: category(
        'verification_test',
        'verification_reminder',
        'welcome',
        'milestone_reached',
        'status_link',
        'giveaway_entry_receipt',
        'giveaway_winner',
        'weekly_campaign_update',
        'member_status',
      ),
    }),
  }),
} as const);

export type EventName = keyof typeof eventRegistry;
export type ServerEventName = {
  [Name in EventName]: (typeof eventRegistry)[Name]['source'] extends 'server'
    ? Name
    : never;
}[EventName];

type PropertyValue<Definition> = Definition extends { readonly kind: 'boolean' }
  ? boolean
  : Definition extends { readonly allowed: readonly (infer Value)[] }
    ? Value
    : string;

export type EventProps<Name extends EventName> = {
  readonly [
    Key in keyof (typeof eventRegistry)[Name]['properties']
  ]: PropertyValue<(typeof eventRegistry)[Name]['properties'][Key]>;
};

export function isEventName(name: string): name is EventName {
  return Object.hasOwn(eventRegistry, name);
}

export function validServerProperties(
  name: ServerEventName,
  value: unknown,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const properties = eventRegistry[name].properties as Record<
    string,
    { readonly kind: string; readonly allowed?: readonly string[] }
  >;
  const supplied = value as Record<string, unknown>;
  const keys = Object.keys(properties);
  if (
    Object.keys(supplied).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(supplied, key))
  )
    return false;
  return keys.every((key) => {
    const definition = properties[key];
    const entry = supplied[key];
    if (definition?.kind === 'boolean') return typeof entry === 'boolean';
    return (
      definition?.kind === 'category' &&
      typeof entry === 'string' &&
      definition.allowed?.includes(entry) === true
    );
  });
}
