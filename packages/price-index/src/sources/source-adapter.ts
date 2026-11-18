import type { CatalogueFile } from '../schema/catalogue.ts';
import type { MarketsFile } from '../schema/markets.ts';
import type { MissingReason, PriceRecord } from '../schema/price-record.ts';

// The SourceAdapter interface (E11.6-05, ADR-033). A source turns the pages a
// run fetched into observations, gaps the source declares, entries we do not
// track, and the pages it could not read. It decides which pages a run needs;
// it never fetches them, and it never writes a file. The youfundceo adapter
// is the first implementation; a later `direct:<provider>` adapter plugs in
// behind the same interface, with no change to the pipeline.

/** The configuration a source reads: the catalogue and the markets. */
export interface SourceContext {
  readonly catalogue: CatalogueFile;
  readonly markets: MarketsFile;
}

/**
 * One unit of a run, checkpointed as a whole by the fetcher (E11.6-04). A
 * market's unit carries its code; a unit shared by every market has none.
 */
export interface RunUnit {
  readonly id: string;
  readonly market: string | null;
}

/** One fetched page, as the raw store holds it, keyed by its absolute URL. */
export type RawPage =
  | { readonly url: string; readonly outcome: 'ok'; readonly html: string }
  | {
      readonly url: string;
      readonly outcome: 'not_found' | 'http_error' | 'refused';
      readonly detail: string;
    };

/** The pages a run fetched so far, keyed by absolute URL. */
export type RawPages = ReadonlyMap<string, RawPage>;

export interface RawRun {
  /** When the run read the pages, RFC 3339 UTC: every observation's `observed_at`. */
  readonly observedAt: string;
  readonly pages: RawPages;
}

/** A price the source shows for a tracked plan in an enabled market. */
export type Observation = Pick<
  PriceRecord,
  | 'market'
  | 'service_id'
  | 'plan_id'
  | 'billing_period'
  | 'price_source_text'
  | 'price_usd_source'
  | 'source_url'
  | 'source_verified_at'
> & {
  /** The exact local price at the currency's minor-unit exponent. */
  readonly price_local: string;
  readonly currency: string;
  readonly source: string;
  readonly observed_at: string;
};

/**
 * A tracked plan in an enabled market that has no observation, and why.
 * `source_no_price` and `not_on_source` are expected, never errors.
 * `parse_failed` and `market_failed` come with a `PageFailure`.
 */
export interface SourceGap {
  readonly market: string;
  readonly service_id: string;
  readonly plan_id: string;
  readonly billing_period: PriceRecord['billing_period'];
  readonly reason: MissingReason;
  /** The page that says so, or that failed. */
  readonly source_url: string | null;
  /** The source's own words, e.g. its "Not verified yet" label, or the failure. */
  readonly note: string | null;
}

/** A source entry that matches nothing in the catalogue. */
export type UntrackedEntry =
  | {
      readonly kind: 'service';
      readonly source_service: string;
      readonly source_name: string;
      /** A fuzzy suggestion for the founder. It is never applied. */
      readonly suggestion: { readonly service_id: string } | null;
    }
  | {
      readonly kind: 'plan';
      readonly service_id: string;
      readonly source_service: string;
      readonly source_plan: string;
      readonly source_name: string;
      readonly billing_period: PriceRecord['billing_period'];
      /** The enabled markets whose page lists it. */
      readonly markets: readonly string[];
      /** A fuzzy suggestion for the founder. It is never applied. */
      readonly suggestion: { readonly plan_id: string } | null;
    };

/**
 * One row of the source's own list of price changes, kept for E11.6-09's
 * founder-only cross-check. It never alters an observation.
 */
export interface PriceMove {
  readonly source_service: string;
  readonly source_plan: string;
  /** The catalogue's ids when the names match an alias, else null. */
  readonly service_id: string | null;
  readonly plan_id: string | null;
  /** ISO 3166-1 alpha-2, as the source gives it. */
  readonly market: string;
  /** The source's period code, as given (`m`). */
  readonly period: string;
  readonly currency: string;
  /** Exact decimal strings at the currency's minor-unit exponent. */
  readonly old_price: string;
  readonly new_price: string;
  /** The date the source saw the change. */
  readonly date: string;
  /** The last archived copy that still showed the old price, or null. */
  readonly after_date: string | null;
  readonly evidence_url: string;
  /** The source's unexplained 0/1 flag, as a boolean. */
  readonly source_flag: boolean;
  /** The source's approximate USD figures, two decimals, or null. */
  readonly old_usd: string | null;
  readonly new_usd: string | null;
}

/** A page that could not be used, so the plans it covers have a gap. */
export interface PageFailure {
  readonly url: string;
  readonly market: string | null;
  readonly reason: Extract<MissingReason, 'parse_failed' | 'market_failed'>;
  readonly detail: string;
}

export interface SourceParseResult {
  readonly source: string;
  /** One per tracked plan the source prices, sorted like the store's records. */
  readonly observations: readonly Observation[];
  /** One per tracked plan with no observation. */
  readonly gaps: readonly SourceGap[];
  readonly untracked: readonly UntrackedEntry[];
  /** Null when the source's list could not be read; see `failures`. */
  readonly priceMoves: readonly PriceMove[] | null;
  readonly failures: readonly PageFailure[];
}

export interface SourceAdapter {
  /** The adapter's name, e.g. `youfundceo`. */
  readonly id: string;
  /** The `source` every observation carries, e.g. `scraper:youfundceo.com`. */
  readonly source: string;
  /** The only origin the adapter ever asks for. */
  readonly origin: string;
  /** The run's units, in the order they run. Only enabled markets have one. */
  units(context: SourceContext): RunUnit[];
  /**
   * The absolute URLs `unit` still needs, given the pages fetched so far. A
   * page can depend on an earlier one, so the runner fetches what this
   * returns and asks again; an empty list means the unit is complete.
   */
  requests(unit: RunUnit, context: SourceContext, pages: RawPages): string[];
  /** Reads a run's pages. Pure: it fetches nothing and writes nothing. */
  parse(raw: RawRun, context: SourceContext): SourceParseResult;
}

/** The caller handed a source something it cannot read, e.g. a malformed time. */
export class SourceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceInputError';
  }
}
