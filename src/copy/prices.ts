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

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 11 → "11th", 22 → "22nd". */
function ordinal(value: number): string {
  const lastTwo = value % 100;
  const last = value % 10;
  const suffix =
    lastTwo >= 11 && lastTwo <= 13
      ? 'th'
      : last === 1
        ? 'st'
        : last === 2
          ? 'nd'
          : last === 3
            ? 'rd'
            : 'th';
  return `${value}${suffix}`;
}

/** A name that begins a sentence: "the United States" → "The United States". */
function sentenceStart(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** One price: the exact decimal and its ISO 4217 code ("149.00 SEK"). */
function price(amount: string, currency: string): string {
  return `${amount} ${currency}`;
}

/** A plan named as the provider names it: "Spotify Premium — Individual". */
function planLabel(service: string, plan: string): string {
  return `${service} — ${plan}`;
}

/** How far down the ranking a market sits, for the rank sentence. */
function rankPhrase(rank: number, tied: boolean): string {
  const place =
    rank === 1 ? 'most expensive' : `${ordinal(rank)} most expensive`;
  return tied ? `the joint ${place}` : `the ${place}`;
}

function termText(months: number): string {
  return months === 1 ? '1 month' : `${months} months`;
}

/**
 * How a service hub's plan table is ordered (E11.6-12): ranked markets most
 * expensive first, then the markets the index cannot rank, alphabetically.
 */
function hubOrderNote(ranked: number, unranked: number): string {
  if (ranked === 0) {
    return 'Listed in alphabetical order, because we cannot compare these markets yet.';
  }
  return unranked === 0
    ? 'Listed from the most expensive market to the cheapest.'
    : 'Listed from the most expensive market to the cheapest, then the markets we cannot compare yet, in alphabetical order.';
}

export const pricesCopy = {
  dayText,
  monthText,
  ordinal,
  planLabel,
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
    price,
    period: {
      month: 'per month',
      year: 'per year',
    },
    verifiedOn: (date: string) => `Prices verified on ${dayText(date)}.`,
    verifiedBetween: (oldest: string, newest: string) =>
      `Prices verified between ${dayText(oldest)} and ${dayText(newest)}.`,
    /** The page's link to the methodology at `/price-index` (E11.6-13). */
    methodologyLink: 'How we collect and check these prices',
    notAffiliated: (service: string) =>
      `Valstara is an independent seller. It is not affiliated with or endorsed by ${service}, and the names of the services belong to their owners.`,
    /**
     * Price history (E11.6-11): the real changes `changes.json` logged for
     * the plans the page shows, newest first. Hidden when there is none.
     */
    history: {
      heading: 'Price history',
      raised: (oldPrice: string, newPrice: string, detectedOn: string) =>
        `Raised from ${oldPrice} to ${newPrice} in ${monthText(detectedOn)}.`,
      lowered: (oldPrice: string, newPrice: string, detectedOn: string) =>
        `Lowered from ${oldPrice} to ${newPrice} in ${monthText(detectedOn)}.`,
    },
    /**
     * The cross-market comparison (E11.6-11). M counts only the markets
     * `rankMarkets()` ranks; each price is shown in its own market's
     * currency. Hidden for a plan this market has no rank for.
     */
    comparison: {
      heading: 'Compared with our other markets',
      rank: (
        market: string,
        rank: number,
        tied: boolean,
        markets: number,
        plan: string,
      ) =>
        `${sentenceStart(market)} is ${rankPhrase(rank, tied)} of our ${markets} markets for ${plan}.`,
      tableCaption: (markets: number, plan: string) =>
        `The most expensive and the cheapest of our ${markets} markets for ${plan}`,
      columns: {
        position: 'Position',
        market: 'Market',
        price: 'List price',
      },
      mostExpensive: 'Most expensive',
      cheapest: 'Cheapest',
    },
    /** Related services (E11.6-11): same category, same market, generated pages only. */
    related: {
      heading: (market: string) => `Related services in ${market}`,
    },
    /**
     * The FAQ (E11.6-11). A question is asked only when the data answers it,
     * and every answer is filled from the page's own published figures.
     */
    faq: {
      heading: 'Questions about these prices',
      priceQuestion: (service: string, market: string) =>
        `How much does ${service} cost in ${market}?`,
      priceAnswer: (plan: string, amount: string, period: string) =>
        `${plan} costs ${amount} ${period}.`,
      comparisonQuestion: (service: string, market: string) =>
        `How does the ${service} price in ${market} compare with other markets?`,
      historyQuestion: (service: string, market: string) =>
        `Has the ${service} price in ${market} changed?`,
      historyAnswer: {
        raised: (
          plan: string,
          oldPrice: string,
          newPrice: string,
          detectedOn: string,
        ) =>
          `${plan} rose from ${oldPrice} to ${newPrice} in ${monthText(detectedOn)}.`,
        lowered: (
          plan: string,
          oldPrice: string,
          newPrice: string,
          detectedOn: string,
        ) =>
          `${plan} fell from ${oldPrice} to ${newPrice} in ${monthText(detectedOn)}.`,
      },
    },
    /**
     * The Valstara comparison (E11.6-11). Shown only with
     * `prices.valstara_comparison` on and an entry in
     * config/valstara-prices.json, in the market's currency, like for like.
     */
    valstara: {
      heading: 'The Valstara price',
      tableCaption: (service: string, market: string) =>
        `${service} list prices and Valstara prices in ${market}`,
      columns: {
        plan: 'Plan',
        term: 'Term',
        list: 'List price',
        valstara: 'Valstara price',
        below: 'Below list price',
      },
      term: termText,
      below: (percent: string) => `${percent}% below list price`,
      /** The stated basis when the term is not the plan's billing period. */
      basis: (plan: string, months: number, monthly: string) =>
        `For ${termText(months)} of ${plan}, the list price shown is the monthly list price, ${monthly}, multiplied by ${months}.`,
    },
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
  /**
   * The hubs (E11.6-12): `/prices`, the service hub `/prices/{service}` and
   * the market hub `/prices/countries/{country}`. Each lists only generated
   * pages, in local currency, and is dated from the newest verification it
   * shows.
   */
  hubs: {
    /** The breadcrumb name of `/prices`. */
    pricesCrumb: 'Prices',
    notAffiliated:
      'Valstara is an independent seller. It is not affiliated with or endorsed by the services listed, and the names of the services belong to their owners.',
    columns: {
      market: 'Market',
      plan: 'Plan',
      price: 'List price',
      verified: 'Last verified',
    },
    /** The catalogue's categories, as the market hub and `/prices` head them. */
    categories: {
      ai: 'AI tools',
      streaming: 'Streaming',
      music: 'Music',
      productivity: 'Productivity',
      learning: 'Learning',
      fitness: 'Fitness',
    },
    index: {
      heading: 'Subscription prices by service and country',
      title: 'Subscription prices by service and country — Valstara',
      description:
        'List prices of the subscriptions Valstara tracks, by service and by country, in local currency.',
      intro:
        'Each price is a list price in the local currency of its market, with the date we last verified it.',
      servicesHeading: 'Prices by service',
      marketsHeading: 'Prices by country',
      empty:
        'No prices are published yet. We publish a price only once we have verified it.',
    },
    service: {
      heading: (service: string, newest: string) =>
        `${service} prices by country (${monthText(newest)})`,
      title: (service: string, newest: string) =>
        `${service} prices by country (${monthText(newest)}) — Valstara`,
      description: (service: string, newest: string) =>
        `${service} list prices in each of our markets, in local currency, last verified on ${dayText(newest)}.`,
      /** The hub's name: its breadcrumb, and the link to it from a page. */
      name: (service: string) => `${service} prices by country`,
      tableCaption: (plan: string) => `${plan} list prices by market`,
      orderNote: hubOrderNote,
    },
    market: {
      heading: (market: string, newest: string) =>
        `Subscription prices in ${market} (${monthText(newest)})`,
      title: (market: string, newest: string) =>
        `Subscription prices in ${market} (${monthText(newest)}) — Valstara`,
      description: (market: string, newest: string) =>
        `List prices of the subscriptions we track in ${market}, in local currency, last verified on ${dayText(newest)}.`,
      /** The hub's name: its breadcrumb, and the link to it from a page. */
      name: (market: string) => `Subscription prices in ${market}`,
      tableCaption: (category: string, market: string) =>
        `${category} list prices in ${market}`,
    },
    /** The links from a service × market page to its two hubs. */
    pageLinksHeading: 'More prices',
  },
  /**
   * `/price-index` and the monthly reports at `/price-index/{yyyy-mm}`
   * (E11.6-13). The methodology's own prose is the content file
   * src/content/price-index-methodology.md; these are the labels and
   * sentence templates around it and on the reports, each filled from the
   * data. Every sentence must stay literally true of the built system
   * (test/price-index/price-index-methodology.test.ts), and none names the
   * data source.
   */
  priceIndex: {
    /** The breadcrumb name of `/price-index`. */
    crumb: 'Price index',
    /** The Dataset JSON-LD's name and description. */
    dataset: {
      name: 'Valstara subscription price index',
      description:
        "Official list prices of the subscriptions Valstara tracks, in each market it serves, in local currency. We collect them once a month from public price listings, and check them by hand against providers' own pricing pages where needed.",
    },
    reportsHeading: 'Monthly reports',
    noReports: 'No monthly report is published yet.',
    /** A monthly report's link on `/price-index`: "October 2026". */
    reportLink: (month: string) => monthText(`${month}-01`),
    pricesLink: 'See prices by service and country',
  },
  /** A monthly report page, `/price-index/{yyyy-mm}` (E11.6-13). */
  monthly: {
    /** The breadcrumb name, H1 and title: "Price index report: October 2026". */
    name: (month: string) => `Price index report: ${monthText(`${month}-01`)}`,
    title: (month: string) =>
      `Price index report: ${monthText(`${month}-01`)} — Valstara`,
    description: (month: string) =>
      `The list price changes in our price index for ${monthText(`${month}-01`)}, and the most and least expensive of our markets, in local currency.`,
    intro: (markets: number, builtOn: string) =>
      `List prices across our ${markets} ${markets === 1 ? 'market' : 'markets'}, from the price index as updated on ${dayText(builtOn)}. Every price is in its market's own currency.`,
    changesHeading: 'Price changes',
    changesCaption: (month: string) =>
      `List price changes in ${monthText(`${month}-01`)}, largest first`,
    columns: {
      plan: 'Plan',
      market: 'Market',
      was: 'Was',
      now: 'Now',
      change: 'Change',
    },
    noChanges: (month: string) =>
      `No list price we track changed in ${monthText(`${month}-01`)}.`,
    /** A signed `change_percent` as shown: "+15.5%", "-9.2%". */
    percent: (signed: string) =>
      signed.startsWith('-') ? `${signed}%` : `+${signed}%`,
    directionHeading: 'Rises and falls',
    /** The text after the plan's name: " rose in 2 of 4 markets." */
    rose: (count: number, of: number) =>
      ` rose in ${count} of ${of} ${of === 1 ? 'market' : 'markets'}.`,
    fell: (count: number, of: number) =>
      ` fell in ${count} of ${of} ${of === 1 ? 'market' : 'markets'}.`,
    noDirection: 'No plan rose or fell this month.',
    extremesHeading: 'Most and least expensive markets',
    extremesBasis:
      'Markets are ranked by price on a common basis and shown in their own currency.',
    /** The parts of "<plan>: most expensive in <market> (<price>), least expensive in <market> (<price>)." */
    extremes: {
      most: ': most expensive in ',
      least: ', least expensive in ',
      price: (price: string) => ` (${price})`,
      end: '.',
    },
    spread: (ratio: string) =>
      ` The most expensive market costs ${ratio} times the cheapest.`,
    noExtremes:
      'No plan has a published price in two or more markets to compare.',
    unranked: (plans: number) =>
      `${plans} more ${plans === 1 ? 'plan has' : 'plans have'} a published price in fewer than two comparable markets, so ${plans === 1 ? 'it is' : 'they are'} not ranked.`,
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
