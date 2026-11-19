// The monthly report's sentences (E11.6-09). Templates only: the report
// fills them from published figures, so every number in a sentence comes
// from the data. The forbidden-copy scan covers this directory
// (docs/brand/copy-rules.md), and every copy rule applies: sentence case,
// no exclamation marks, no urgency, provider names as the catalogue writes
// them, local currency only, and no credit to the data source.

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export const monthlyReportCopy = {
  /** `2026-11` → `November 2026`. */
  monthName(month: string): string {
    const [year, index] = month.split('-');
    return `${monthNames[Number(index) - 1]} ${year}`;
  },

  /** `2026-11-18` → `18 November 2026`. */
  dayName(date: string): string {
    const [year, index, day] = date.split('-');
    return `${Number(day)} ${monthNames[Number(index) - 1]} ${year}`;
  },

  title(monthName: string): string {
    return `Price index: ${monthName}`;
  },

  introduction(markets: number, builtOn: string): string {
    return `Official list prices across our ${markets} ${plural(markets, 'market', 'markets')}, from the price index as built on ${builtOn}. Every price is in its market's own currency.`;
  },

  plan(service: string, plan: string): string {
    return `${service} — ${plan}`;
  },

  changesHeading: 'Price changes',
  changesColumns: ['Plan', 'Market', 'Was', 'Now', 'Change'] as const,
  noChanges(monthName: string): string {
    return `No list price we track changed in ${monthName}.`;
  },

  price(price: string, currency: string): string {
    return `${price} ${currency}`;
  },

  percent(signed: string): string {
    return signed.startsWith('-') ? `${signed}%` : `+${signed}%`;
  },

  directionHeading: 'Rises and falls',
  rose(plan: string, count: number, of: number): string {
    return `${plan} rose in ${count} of ${of} ${plural(of, 'market', 'markets')}.`;
  },
  fell(plan: string, count: number, of: number): string {
    return `${plan} fell in ${count} of ${of} ${plural(of, 'market', 'markets')}.`;
  },
  noDirection: 'No plan rose or fell this month.',

  extremesHeading: 'Most and least expensive markets',
  extremes(
    plan: string,
    most: { market: string; price: string },
    least: { market: string; price: string },
  ): string {
    return `${plan}: most expensive in ${most.market} (${most.price}), least expensive in ${least.market} (${least.price}).`;
  },
  spread(ratio: string): string {
    return `The most expensive market costs ${ratio} times the cheapest.`;
  },
  extremesBasis:
    'Markets are ranked by price on a common basis and shown in their own currency.',
  noExtremes:
    'No plan has a published price in two or more markets to compare.',
  unranked(plans: number): string {
    return `${plans} more ${plural(plans, 'plan has', 'plans have')} a published price in fewer than two comparable markets, so ${plural(plans, 'it is', 'they are')} not ranked.`;
  },

  crossCheckHeading:
    "Cross-check against the source's price moves (founder only)",
  crossCheckNotice:
    'For the founder only: remove this section before the report is sent. It compares our change log with the price moves the source lists, and it never changes a value.',
  crossCheckRuns(runs: string): string {
    return `Price moves read from: ${runs}.`;
  },
  crossCheckMissingRuns(runs: string): string {
    return `No price moves in the raw store for: ${runs}. Moves only those runs read are not checked.`;
  },
  crossCheckUnavailable:
    'The cross-check could not run: no build of this month still has its price moves in the raw store.',
  undetectedHeading: 'Moves the source lists that our log does not hold',
  unlistedHeading: 'Changes in our log that the source does not list',
  none: 'None.',
  move(
    plan: string,
    market: string,
    was: string,
    now: string,
    date: string,
  ): string {
    return `${plan}, ${market}: ${was} to ${now}, dated ${date} by the source.`;
  },
  change(
    plan: string,
    market: string,
    was: string,
    now: string,
    date: string,
  ): string {
    return `${plan}, ${market}: ${was} to ${now}, detected ${date}.`;
  },
} as const;
