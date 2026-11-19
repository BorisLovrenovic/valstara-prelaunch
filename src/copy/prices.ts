// The price pages' copy (E11.6-10; docs/features/price-index.md#pages). Every
// sentence on a price page is one of these templates, filled from published
// data and nothing else: nothing is typed per page. A price is shown only in
// its market's own currency, exactly as the published record holds it, and
// no page credits the data source (founder, 2026-11-17).

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

/** `YYYY-MM-DD` as "14 November 2026". */
function dayText(date: string): string {
  const [year, month, day] = date.split('-');
  return `${Number(day)} ${monthNames[Number(month) - 1]} ${year}`;
}

/** `YYYY-MM-DD` as "November 2026". */
function monthText(date: string): string {
  const [year, month] = date.split('-');
  return `${monthNames[Number(month) - 1]} ${year}`;
}

export const pricesCopy = {
  dayText,
  monthText,
  breadcrumbLabel: 'Breadcrumb',
  home: 'Valstara',
  page: {
    /** The H1, and the title before the brand: dated from the last verification. */
    heading: (service: string, market: string, newest: string) =>
      `${service} price in ${market} (${monthText(newest)})`,
    title: (service: string, market: string, newest: string) =>
      `${service} price in ${market} (${monthText(newest)}) — Valstara`,
    description: (service: string, market: string, newest: string) =>
      `${service} list prices in ${market}, shown in local currency and last verified on ${dayText(newest)}.`,
    /** The breadcrumb and structured-data name of the page. */
    name: (service: string, market: string) => `${service} price in ${market}`,
    tableCaption: (service: string, market: string) =>
      `${service} plans and list prices in ${market}`,
    columns: {
      plan: 'Plan',
      price: 'List price',
      verified: 'Last verified',
    },
    /** One plan's price: the exact decimal and its ISO 4217 code. */
    price: (amount: string, currency: string) => `${amount} ${currency}`,
    period: {
      month: 'per month',
      year: 'per year',
    },
    verifiedOn: (date: string) => `Prices verified on ${dayText(date)}.`,
    verifiedBetween: (oldest: string, newest: string) =>
      `Prices verified between ${dayText(oldest)} and ${dayText(newest)}.`,
    notAffiliated: (service: string) =>
      `Valstara is an independent seller. It is not affiliated with or endorsed by ${service}, and the names of the services belong to their owners.`,
    cta: {
      heading: 'Join the Valstara waitlist',
      body: 'Join the waitlist for earlier access to Valstara, a direct seller of digital goods backed by the Triple Guarantee.',
    },
    signupPaused: {
      heading: 'Signups are paused',
      body: "We're not taking new signups right now. Check back in a little while — the waitlist will reopen soon.",
    },
  },
  /**
   * A published URL whose data is lost (or whose service or market has left
   * the configuration): it keeps rendering, with no price, until data
   * returns or it is retired (docs/features/price-index.md#edge-cases-and-
   * error-states).
   */
  unavailable: {
    heading: (service: string, market: string) =>
      `${service} price in ${market}`,
    title: (service: string, market: string) =>
      `${service} price in ${market} — temporarily unavailable — Valstara`,
    description: (service: string, market: string) =>
      `The ${service} price in ${market} is temporarily unavailable on Valstara.`,
    note: 'This price is temporarily unavailable. We show a price only while we have a verified one, so this page has none right now.',
  },
  /** Every price route while `prices.pages` is off: HTTP 503, `noindex`. */
  paused: {
    meta: {
      title: 'Prices are temporarily unavailable — Valstara',
      description: 'Valstara price pages are temporarily unavailable.',
    },
    heading: 'Prices are temporarily unavailable',
    body: 'Our price pages are offline for a short while. Please check back later.',
    home: 'Go to the home page',
  },
} as const;
