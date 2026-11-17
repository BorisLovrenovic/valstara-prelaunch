# Price index: source findings (E11.6-01)

The E11.6-01 discovery spike, written on 2026-11-17 **from the founder's capture only**. No agent session requested the source site. The capture is in `packages/price-index/test/fixtures/youfundceo/`, listed in its `manifest.tsv` with the URL, status, capture time and SHA-256 of each file. `test/price-index/fixture-manifest.test.mjs` checks the files against it. The spec this informs is `docs/features/price-index.md`.

**Nothing in this file changes a later ticket.** The proposed changes at the end go to the founder as decisions (`AGENTS.md#stop-and-ask`).

## What was captured

| Capture | When (UTC, 2026-11-17) | What |
|---|---|---|
| Plain scripted requests (first capture) | 13:13–13:16 | `raw/robots.txt`, `raw/sitemap.xml` (both `200`), and `/`, `/countries` and `/services`, each a `429` bot checkpoint. Each response's headers are beside it in `raw/*.headers` |
| Headless Chromium (P9 capture) | 13:57–14:14 | 76 pages, each saved twice: as the browser rendered it (`pages/<name>.html`) and as the server sent it (`pages/<name>.server.html`). Five full-page screenshots and two HAR files in `browser/` |

The 76 pages are the home page, `/countries`, `/services`, `/services/netflix`, `/services/spotify`, the 38 country pages, the twelve country × service pages, `/price-moves` and `/terms`. **All 38 countries answered `200`** with their own page, so none is missing or substituted. No saved page is the checkpoint.

Gaps against the ticket's list:

- The screenshots cover five page types: `/countries`, a country page, a service page, a country × service page and "Price moves". The capture script (`docs/prerequisites/p9-source-capture.md`) does not screenshot `/services` or `/terms`.
- The five `raw/*.headers` files have no row in `manifest.tsv`, because the first, plain capture wrote them without one. The headless capture's rows are all present.

## `robots.txt`, verbatim

Captured 2026-11-17T13:13:39Z (`raw/robots.txt`, SHA-256 `508e388e…c995`):

```text
User-Agent: *
Allow: /
Disallow: /api/
Disallow: /go/

User-Agent: GPTBot
User-Agent: CCBot
User-Agent: ClaudeBot
User-Agent: anthropic-ai
User-Agent: Claude-Web
User-Agent: Google-Extended
User-Agent: Applebot-Extended
User-Agent: Meta-ExternalAgent
User-Agent: FacebookBot
User-Agent: Bytespider
User-Agent: cohere-ai
User-Agent: cohere-training-data-crawler
User-Agent: AI2Bot
User-Agent: Ai2Bot-Dolma
User-Agent: PanguBot
User-Agent: Timpibot
User-Agent: Kangaroo Bot
User-Agent: img2dataset
User-Agent: Diffbot
User-Agent: Omgilibot
User-Agent: omgili
User-Agent: Webzio-Extended
User-Agent: ImagesiftBot
User-Agent: DataForSeoBot
User-Agent: magpie-crawler
User-Agent: Scrapy
Disallow: /

Host: https://www.youfundceo.com
Sitemap: https://www.youfundceo.com/sitemap.xml
```

**Which group applies to the tool.** Under E11.6-04's founder decision 2, the fetcher is headless Chromium presenting as an ordinary browser. Its `User-Agent`, as the capture sent it (both HAR files), is `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36`. That carries no product token that any named group lists, so **the `*` group applies**: everything is allowed except `/api/` and `/go/`. The superseded D6 token `PriceIndexBot` is not named either, so it would also fall to `*`. **There is no `Crawl-delay`**, so the tool's own 8–20 s jitter is the only delay. `Host:` is a non-standard directive and changes nothing.

`sitemap.xml` is a sitemap index of ten child sitemaps: `core`, `services`, `countries`, and per-service sitemaps for `adobe`, `apple-music`, `chatgpt`, `disney-plus`, `netflix`, `spotify` and `youtube-premium`. The child sitemaps were not captured.

## Structure and slug scheme

The founder's known structure is **confirmed**, with the corrections in bold.

| Page type | Path | Slug scheme | Notes |
|---|---|---|---|
| Home | `/` | — | Links to "Price moves" and "Terms" from the footer |
| Country index | `/countries` | — | 248 distinct country links, each with its service count. The site says it covers 245 countries |
| Country page | `/countries/{country}` | Lower-case English name, hyphenated: `united-kingdom`, `bosnia-and-herzegovina`, `czech-republic`, `new-zealand` | All 20 markets' slugs resolve from `/countries` |
| Service index | `/services` | — | **41 services**, as the founder said |
| Service page | `/services/{service}` | **Not always the brand name**: `adobe` (Adobe Creative Cloud), `apple-tv-plus` (Apple TV), `amazon-prime`, `prime-video`, `youtube-premium`, `gemini` (Google AI) | Every country's main-plan price, a service-wide "last checked" date and the history |
| Country × service page | `/services/{service}/{country}` | Both slugs as above | All plans in that country, with a per-country "Checked" date |
| **Plan page** | **`/services/{service}/plans/{plan}`** | e.g. `/services/netflix/plans/basic` | **Not in the known structure.** Linked from each plan row. Not captured and not needed |
| Price moves | **`/price-moves`** | — | Confirmed path |
| Terms of use | **`/terms`** | — | Also `/disclaimer` and `/privacy` exist; not captured |

The 41 service slugs, from `/services`: `adobe`, `amazon-music`, `amazon-prime`, `apple-arcade`, `apple-fitness-plus`, `apple-music`, `apple-one`, `apple-tv-plus`, `audible`, `babbel`, `bitdefender`, `chatgpt`, `claude`, `coursera-plus`, `dazn`, `deezer`, `disney-plus`, `gemini`, `google-one`, `grok`, `hbo-max`, `icloud-plus`, `iqiyi`, `microsoft-365`, `mubi`, `netflix`, `nintendo-switch-online`, `nordvpn`, `paramount-plus`, `playstation-plus`, `prime-video`, `proton`, `soundcloud`, `spotify`, `twitch-turbo`, `ubisoft-plus`, `viki`, `viu`, `xbox-game-pass`, `youtube-premium`, `zee5`.

## Server-rendered, not built in the browser

**Every fact we need is in the HTML the server sends.** The site is a Next.js App Router application on Vercel. Pages are prerendered (`x-nextjs-prerender: 1`, `x-vercel-cache: PRERENDER`, `x-nextjs-stale-time: 300`).

- On all 38 country pages, the priced list and the "No price shown" list are identical in the server copy and the rendered copy.
- The country × service, service, price-moves and terms pages differ between the two copies only in hydration details: the footer's position and a date suffix. No price differs.
- Only two parts are built in the browser, and neither is needed. The country picker shows "Loading prices…". The "Show more" button on "Price moves" reveals rows already in the server response (see below).

So the fetcher needs JavaScript only to get past the bot checkpoint, if it ever appears, and never to see content.

## The embedded data

Next.js App Router has no `__NEXT_DATA__`. Its embedded data is the React Server Components payload in `self.__next_f.push([1, "…"])` scripts. The rows split across pushes, so the strings must be joined before reading. It is a serialised render tree, not a data API. The values we need sit in it as the props of client components:

- **Prices**, on country and country × service pages: `{"usd":16.78,"official":{"amount":169,"currency":"SEK","yearly":false}}`. On a country × service page, each plan row's React key is `"<plan>-<month|year>"`, e.g. `"basic-month"` and `"cc-pro-month"`. **The amount is a JSON number** (`932.5` for `kr 932.50`), so the adapter must read the number's text and never let `JSON.parse` turn it into a float (epic rule 3). On all 38 country pages, every `official.amount` equals the displayed number.
- **Price moves**: one `rows` prop holding all of them (see "Price moves").

Component references such as `$L3f` are renumbered by each deployment. The prop names `official`, `amount`, `currency`, `yearly` and `usd` are the site's own names and do not depend on the deployment.

## Which page type carries each fact

| Fact | Page type that carries it | Where on the page |
|---|---|---|
| **Plan-level prices** | **Country × service page only** | "All plans in <country>" (`section[aria-labelledby="plans"]`). The country page shows **only each service's main plan**, e.g. Netflix Standard, Adobe Creative Cloud Pro. The service page shows only the main plan, in every country |
| **The local price and its currency** | Country × service page (every plan); country page (main plan) | Embedded `official.amount` and `official.currency` (ISO 4217). The visible text carries a symbol only for the country's own currency (`kr 169`), and adds the ISO code for any other (`€18 EUR`, `$20 USD`) |
| **The approximate USD figure** | Same pages | Embedded `usd`; displayed as `≈ $16.78 / mo`. **The source converts it** at a weekly exchange rate ("Rates by Exchange Rate API"). For a yearly price, it divides by 12 |
| **The "last checked" date** | **Country × service page only**, one per service and country, not per plan | JSON-LD `Dataset.dateModified` (`"2026-11-04"`), which equals the visible "Checked 4 Nov 2026 on help.netflix.com" on all twelve captured pairs. The country page has none in its price list. The service page has one service-wide date, which is the latest across countries: Netflix US was checked 28 Oct, but `/services/netflix` says 4 Nov |
| **"No price shown for <country>"** | Country page only | `section` under `h2#unavailable`. Each entry is labelled **"Not verified yet"** or **"Not available here"** |
| **Whether a plan is absent in a country** | Country × service page, by omission only | The plan is missing from "All plans". Netflix in the United States lists Standard, **Standard with ads** and Premium, and **no Basic**; Sweden lists Basic. The source has **no explicit "plan not offered" marker**. "Not available here" exists only per service, on the country page |
| **"What you get in <country>"** (not read) | Country page and country × service page | `h2#what-you-get`, and its "What the page says" quotes |

**The billing period.** `official.yearly` and the row key's `-month`/`-year` suffix give it. Every captured row of a tracked service is monthly. Babbel and Bitdefender show yearly prices: `kr 1,079.88` is a year, and its `≈ $8.94 / mo` is that year divided by 12.

**Tax.** On a United States country × service page, the plan text is `$19.99 + tax`. The country page shows the same price as `$19.99`. `price_source_text` should therefore always be taken from the same page type.

## The extraction source for each page type

The ticket's order of preference is embedded framework data, then JSON-LD, then HTML. **Nothing under `/api/` or `/go/` is a candidate.**

| Page type | Extraction source | Why it is the most stable |
|---|---|---|
| `/robots.txt` | The text | — |
| `/countries` | **HTML**: the `a[href^="/countries/"]` links | The JSON-LD holds only breadcrumbs. The links are the site's permanent URLs, which its sitemap also publishes, so they change less than any data shape |
| `/services` | **HTML**: the `a[href^="/services/"]` links (41) | As for `/countries` |
| Country page | **HTML**: `li[data-name] > a.prow[href]` in the price list and under `h2#unavailable`, **cross-checked against the JSON-LD `ItemList`** | The "No price shown" list exists **only in the HTML**. Reading both lists from one source keeps them consistent. The JSON-LD `ItemList`, a schema.org contract meant for search engines, names exactly the priced services with their country × service URLs: it matched the HTML on all 38 pages, in count, URLs and order. A disagreement fails the page as `parse_failed`. Prices are not taken from this page |
| **Country × service page** | **Embedded data**: each plan row's `official` and `usd` props and its `"<plan>-<period>"` key. **The JSON-LD `Dataset.dateModified`** gives `source_verified_at`. The plan row's visible text gives `price_source_text`, and its number must equal `official.amount` | It is the only source that carries the **ISO currency code** and the **billing period** as data. The visible text writes four currencies as `kr` (SEK, NOK, DKK, ISK) and states no period. JSON-LD carries no price, only prose in `description` and the FAQ. It does carry the check date as an ISO date, which is sturdier than parsing "Checked 4 Nov 2026" |
| Price moves | **Embedded data**: the `rows` prop | The HTML shows only the newest 30 of 205 rows ("Show more (175 left)"), and has no JSON-LD beyond breadcrumbs |
| Service page | Not needed by a run | — |

**Risk.** The embedded payload is a framework wire format, not a published API. A Next.js upgrade or a redesign on the source can change it without notice. The adapter must find each `official` object inside its plan row. It must fail the page as `parse_failed` if any plan row lacks one, if the visible number disagrees, or if the JSON-LD check fails. It must never yield zero records silently.

## The minimum request set for a monthly run

Every count is from the capture of 2026-11-17, for the 20 markets.

| Requests | Count |
|---|---|
| `/robots.txt` | 1 |
| `/countries` and `/services` (slug resolution) | 2 |
| The 20 country pages | 20 |
| Country × service pages for tracked services the source **prices** in that market | **148**, or 149 if `prime-video` is mapped (it is priced only in the United States) |
| `/price-moves` | 1 |
| **Total** | **≈ 172 page loads** |

The tracked services on the source are Adobe, Amazon Prime, Apple TV, Apple Music, ChatGPT, Netflix, Spotify and YouTube Premium. Per market:

| Market | Priced on the source | "No price shown" | Not listed at all |
|---|---|---|---|
| United Kingdom, Germany, Spain, France, Italy, Poland, Sweden, Netherlands, Ireland, Austria, Canada | all 8 | Prime Video | — |
| Norway, Denmark, Finland, Switzerland, Portugal | 7 | Prime Video | Amazon Prime |
| Australia | 7 | Prime Video, YouTube Premium | — |
| Romania | 5 | Prime Video, Apple Music, YouTube Premium | Amazon Prime |
| Croatia | 5 | Adobe, Prime Video, Apple Music | Amazon Prime |
| United States | all 8, and Prime Video | — | — |

Every "No price shown" entry for these services in the 20 markets is "Not verified yet".

**Duration.** In the two HAR files, the document answered in 0.8–1.3 s, and the page finished loading in 1.1–1.6 s. With the default 8–20 s jitter (14 s mean), 172 loads take about **45–50 minutes**, and at most about 70 minutes. **The spec's estimate of "roughly 460 requests, about two hours" is high**, because 11 of the 19 tracked products are not on the source.

**A page load is not one request.** Each HAR records 35 requests for one page: fonts, scripts and the stylesheet (all `immutable`, so cached after the first page), plus **10–13 Next.js link prefetches** (`?_rsc=…` with `next-router-prefetch: 1`). The prefetches fetch other source pages in parallel: `/`, `/services`, `/countries`, `/calculator` and the first few linked country × service pages. Left alone, a run would make roughly 1,900 page-level requests, several at once. That breaks "one page at a time" (proposed change 1).

## Price moves

`/price-moves` lists **205 changes since November 2024, all rises**: Apple Music 147, Netflix 49, Spotify Premium 9. They are newest first, and 76 are in our 20 markets. Each row of the embedded `rows` prop is a tuple:

`[service, plan, country ISO 3166-1 alpha-2, period ("m"), currency, old amount, new amount, date, "after" date or null, evidence URL, flag (0/1), old USD or null, new USD or null]`

e.g. `["netflix","basic","HR","m","EUR",5.99,6.99,"2026-11-04",null,"https://help.netflix.com/en/node/24926/hr",0,6.61,7.71]`.

- "After" dates are, in the page's words, "the last archived copy that still showed the old price". Those rows link to `web.archive.org`.
- The page does not explain the flag. Nine Apple Music United States rows carry `1`.
- Amounts are JSON numbers, as above. Only three services appear, so the E11.6-09 cross-check can cover only Apple Music, Netflix and Spotify.

## Local number and currency formats

**The source does not use local number formats.** It writes every price in the same English style, whatever the country:

- the symbol before the number;
- `.` for decimals and `,` for thousands;
- for a symbol made of letters, a **no-break space** (U+00A0) between symbol and number: `kr 169`, `Kč 2,449`, `CHF 23.40`, `Ft 2,790`, `zł 15.50`, `lei 39.99`, `RSD 2,599`;
- for `€`, `£`, `$`, `A$`, `CA$` and `NZ$`, no space;
- a currency other than the country's own adds its ISO code, after an ordinary space, in `span.cur-tag` (`€18 EUR`, `$20 USD`, `A$9.99 AUD`).

The table below has one row per captured country (⍽ marks the no-break space). Whole amounts show no decimals (`kr 69`). No captured price uses `.`, a space, a narrow no-break space or an apostrophe as a thousands separator, and none puts the symbol after the number.

| Country | Market | Currencies on the page (ISO code from the embedded data × rows) | Examples, as displayed | Thousands seen |
|---|---|---|---|---|
| Sweden | yes | SEK ×30, EUR ×1, USD ×1 | `kr⍽1,079.88`, `kr⍽70` · `€18 EUR` · `$59 USD` | `kr⍽1,079.88` |
| Germany | yes | EUR ×36 | `€107.88`, `€8` | none |
| United Kingdom | yes | GBP ×37 | `£66.49`, `£7` | none |
| Poland | yes | PLN ×29, EUR ×3, USD ×1 | `zł⍽299.88`, `zł⍽25` · `€80.61 EUR`, `€18 EUR` · `$59 USD` | none |
| Romania | yes | RON ×15, EUR ×7, USD ×2 | `lei⍽399.99`, `lei⍽40` · `€79.30 EUR`, `€18 EUR` · `$11.99 USD`, `$59 USD` | none |
| Norway | yes | NOK ×26, USD ×4 | `kr⍽961.25`, `kr⍽38` · `$107.40 USD`, `$59 USD` | none |
| Denmark | yes | DKK ×26, EUR ×2, USD ×2 | `kr⍽612.50`, `kr⍽9` · `€95.88 EUR`, `€18 EUR` · `$4.99 USD`, `$59 USD` | none |
| Switzerland | yes | CHF ×29, USD ×2 | `CHF⍽131.88`, `CHF⍽1` · `$20 USD`, `$59 USD` | none |
| Canada | yes | CAD ×36 | `CA$143.40`, `CA$81` | none |
| Australia | yes | AUD ×37 | `A$113.49`, `A$16` | none |
| Austria | yes | EUR ×33 | `€107.88`, `€8` | none |
| Belgium | fixture only | EUR ×31 | `€79.30`, `€8` | none |
| Bosnia and Herzegovina | fixture only | USD ×12, EUR ×6 | `$107.40 USD`, `$35 USD` · `€11.99 EUR`, `€7 EUR` | none |
| Croatia | yes | EUR ×21, USD ×3 | `€83.88`, `€8` · `$11.99 USD`, `$59 USD` | none |
| Cyprus | fixture only | EUR ×20, USD ×1 | `€83.88`, `€8` · `$11.99 USD` | none |
| Czech Republic | fixture only | CZK ×21, EUR ×4, USD ×3 | `Kč⍽549.99`, `Kč⍽99` · `€79.30 EUR`, `€18 EUR` · `$11.99 USD`, `$59 USD` | `Kč⍽2,449` |
| Estonia | fixture only | EUR ×23, USD ×1 | `€81.27`, `€8` · `$11.99 USD` | none |
| Finland | yes | EUR ×30 | `€82.25`, `€8` | none |
| France | yes | EUR ×35 | `€78.65`, `€8` | none |
| Greece | fixture only | EUR ×24, USD ×1 | `€81.27`, `€7` · `$11.99 USD` | none |
| Hungary | fixture only | HUF ×20, EUR ×4, USD ×3 | `Ft⍽32,999`, `Ft⍽399` · `€83.24 EUR`, `€18 EUR` · `$11.99 USD`, `$59 USD` | `Ft⍽2,790` |
| Iceland | fixture only | USD ×10, EUR ×8, ISK ×3 | `$107.40 USD`, `$59 USD` · `€17.99 EUR`, `€23 EUR` · `kr⍽1,190`, `kr⍽1,350` | `kr⍽1,190` |
| Ireland | yes | EUR ×32 | `€80.61`, `€8` | none |
| Italy | yes | EUR ×35 | `€79.96`, `€8` | none |
| Latvia | fixture only | EUR ×24, USD ×1 | `€79.30`, `€8` · `$11.99 USD` | none |
| Liechtenstein | fixture only | CHF ×13, USD ×5 | `CHF⍽23.40`, `CHF⍽8` · `$107.40 USD`, `$59 USD` | none |
| Lithuania | fixture only | EUR ×23, USD ×2 | `€79.30`, `€8` · `$11.99 USD`, `$59 USD` | none |
| Luxembourg | fixture only | EUR ×27, USD ×1 | `€76.68`, `€8` · `$11.99 USD` | none |
| Malta | fixture only | EUR ×24, USD ×1 | `€83.88`, `€8` · `$11.99 USD` | none |
| Netherlands | yes | EUR ×33 | `€107.88`, `€8` | none |
| New Zealand | fixture only | NZD ×26, USD ×3, AUD ×1 | `NZ$131.68`, `NZ$17` · `$107.40 USD`, `$59 USD` · `A$9.99 AUD` | none |
| North Macedonia | fixture only | USD ×15, EUR ×4 | `$107.40 USD`, `$8 USD` · `€13.99 EUR`, `€5.99 EUR` | none |
| Portugal | yes | EUR ×30, USD ×1 | `€80.61`, `€8` · `$11.99 USD` | none |
| Serbia | fixture only | USD ×8, EUR ×6, RSD ×6 | `$107.40 USD`, `$35 USD` · `€19.17 EUR`, `€7 EUR` · `RSD⍽2,599`, `RSD⍽819` | `RSD⍽2,599` |
| Slovakia | fixture only | EUR ×24, USD ×1 | `€80.61`, `€8` · `$11.99 USD` | none |
| Slovenia | fixture only | EUR ×22, USD ×1 | `€79.96`, `€8` · `$11.99 USD` | none |
| Spain | yes | EUR ×35 | `€79.30`, `€8` | none |
| United States | yes | USD ×39 | `$107.40`, `$8` | none |

**`kr` is ambiguous**: it stands for SEK, NOK, DKK and ISK. That is one more reason to take the currency from the embedded `official.currency`, never from the symbol.

**The local currency is not always the market's currency.** In our markets, Adobe Creative Cloud is priced in **EUR in Poland and Romania**, and Netflix in **EUR in Romania**. Untracked examples elsewhere: Claude in EUR in Sweden, Coursera in USD. Under the spec's rule that the currency must equal the market's, these three records are flagged every month (proposed change 5).

## Conditional requests and the bot checkpoint

**Conditional requests.** HTML responses carry a **weak** `ETag` (`W/"36e6…577e"`), no `Last-Modified`, and `cache-control: public, max-age=0, must-revalidate`. `robots.txt` carries a strong `ETag`, and a `Last-Modified` equal to the response time, so it is generated per request. `sitemap.xml` carries both. **The capture made no conditional request, so whether the source answers `304` is unknown.** It is unlikely to matter, for two reasons:

- the pages embed the week's exchange rate (`"fx":{"day":"2026-11-16",…}`), so every page changes at least weekly, and a monthly run would see a new `ETag` every time;
- a fresh browser context per run has nothing to revalidate against.

**The bot checkpoint.** These responses are in `raw/`.

- **Challenged:** every plain scripted request for an HTML page (`/`, `/countries`, `/services`). **Not challenged:** `robots.txt` and `sitemap.xml`.
- **A challenged response:**
  - HTTP `429`;
  - `x-vercel-mitigated: challenge`;
  - a fresh `x-vercel-challenge-token`;
  - `cache-control: private, no-store, max-age=0`;
  - a 10.6 KB gzipped page titled **"Vercel Security Checkpoint"**, saying "We're verifying your browser" and, without JavaScript, "Enable JavaScript to continue";
  - one obfuscated module script.
- **The checkpoint is a JavaScript browser check, not a CAPTCHA.** No CAPTCHA widget, image or prompt is in the page.
- **What the headless browser did, and what it got.** The capture script took three measures:
  - it replaced `HeadlessChrome` with `Chrome` in the `User-Agent`;
  - it launched with `--disable-blink-features=AutomationControlled`;
  - it hid `navigator.webdriver`.

  It sent the browser's ordinary navigation headers, with `sec-ch-ua: "Chromium";v="151"` and the platform `Linux`. **All 76 pages answered `200`**, with no checkpoint row in the manifest. The HAR contexts were fresh, and their first document request answered `200` directly, so the checkpoint never showed. Whether it would clear if it did show is not observable from this capture.
- **Detecting it** (for E11.6-04): a `403` or `429` status, or `x-vercel-mitigated: challenge`, or the title "Vercel Security Checkpoint".

## Name mappings between the source and the catalogue

**Confirmed** means the service and the plan carry the catalogue's name on the source. **Founder-confirmed** and **unmapped by founder decision** record the founder's answers of 2026-11-17 to the rows the capture left uncertain (D-019 Q4, recorded on E11.6-02). No mapping below is applied anywhere. E11.6-02 seeds `source_aliases` only from the confirmed and founder-confirmed rows.

| Catalogue product — plan | Source service (slug) — plan as named (row key) | Status |
|---|---|---|
| Apple Music — Individual | Apple Music (`apple-music`) — "Individual" (`individual`) | **Confirmed** |
| ChatGPT — Plus | ChatGPT (`chatgpt`) — "ChatGPT Plus" (`plus`) | **Confirmed** |
| Spotify Premium — Individual | Spotify Premium (`spotify`) — "Premium Individual" (`individual`) | **Confirmed** |
| YouTube Premium — Individual | YouTube Premium (`youtube-premium`) — "Individual" (`individual`) | **Confirmed** |
| Netflix — Standard | Netflix (`netflix`) — "Standard" (`standard`) | **Confirmed** |
| Netflix — Basic | Netflix — "Basic" (`basic`), in Sweden. **Absent in the United States**, which lists "Standard with ads" (`standard-ads`) instead. Price moves records "Basic retired" there in 2023 | **Founder-confirmed, 2026-11-17**: "Basic" (`basic`) only. "Standard with ads" (`standard-ads`) is never an alias for Basic. Where the source lists no Basic, as in the United States, the plan stays `missing` until the founder records a `not_offered` entry |
| Netflix — Premium (4K) | Netflix — "Premium" (`premium`). Its Swedish feature list says "up to 4K (Ultra HD)" | **Founder-confirmed, 2026-11-17**: "Premium" (`premium`) |
| Adobe Creative Cloud — the individual plan | Adobe Creative Cloud (`adobe`) — "Creative Cloud Pro" (`cc-pro`), the main plan. Other plans: Photoshop, Acrobat Pro, Lightroom (1TB), Adobe Express Premium, Acrobat Standard, and "(monthly plan)" variants of the two Acrobats | **Unmapped by founder decision, 2026-11-17**: no alias; the plan stays `missing` until the founder decides, because Creative Cloud Pro carries Adobe's annual-commitment price. As captured: Creative Cloud Pro is the all-apps plan for an individual. Its United States price, $69.99 a month, matches Adobe's annual plan paid monthly. Only the Acrobat plans have a "(monthly plan)" variant, so Creative Cloud Pro's monthly-commitment price is not on the source. It is priced in EUR in Poland and Romania, and is "Not verified yet" in Croatia |
| Amazon Prime / Prime Video — Prime | Amazon Prime (`amazon-prime`) — "Prime". Separately, Prime Video (`prime-video`) — "Prime Video" | **Founder-confirmed, 2026-11-17**: Amazon Prime (`amazon-prime`) "Prime" only; Prime Video (`prime-video`) is not an alias. As captured: Amazon Prime is priced in 13 of our markets, and not listed in Norway, Denmark, Finland, Switzerland, Portugal, Romania or Croatia. Prime Video is priced only in the United States and is "Not verified yet" in the other 19 |
| Apple TV — Individual | Apple TV (`apple-tv-plus`) — "Apple TV", its only plan on the country pages | **Founder-confirmed, 2026-11-17**: Apple TV (`apple-tv-plus`) "Apple TV". As captured: no country × service page was captured, so its plan list is unseen |

**Tracked products the source does not list** (none of the 41 services). They become `missing` / `not_on_source` in every market, as the spec expects:

- Bolt.new — Pro
- Canva — Pro
- Crunchyroll — Mega Fan
- Duolingo — Super, Max
- Figma — Professional
- LinkedIn Premium — Career, Business
- **Lovable — the paid plan.** Lovable is not on the source, so the plan ambiguity the brief raised does not arise there
- MyFitnessPal — Premium
- n8n — Starter
- Notion — Plus
- Perplexity — Pro

That is 11 of the 19 products, and 13 of the 24 plans.

## Terms of use

Captured 2026-11-17T14:13:55Z (`pages/terms.server.html`). The clauses on automated access and reuse, verbatim:

> The short version: look things up, compare and share links as much as you like. Don't copy our database with scripts, and don't republish it.

> **Personal, non-commercial use** … Anything else, such as using our prices in a product, a service, a paid report or a business, needs our written permission first. Get in touch if you'd like to work with our data.

> **No automated collection**
> You may not, yourself or through anyone else:
> - collect data from the site with scrapers, crawlers, bots, scripts, headless browsers or any other automated means;
> - download prices, history or other data in bulk, or call the site's data endpoints outside our pages;
> - get around rate limits, blocks or other measures that protect the site;
> - use our data to train or improve machine learning or AI models.
>
> Search engines may index our pages as our robots.txt allows. We may block anyone who breaks these rules, without notice.

> **Don't republish the database**
> Each price is a public fact, but our collection is our work: which services and countries we cover, how we verify each price, the history we keep, and the notes on countries we couldn't verify. You may not copy, republish, sell or redistribute that collection or a substantial part of it, in any form, or use it to build a competing database.

**For the founder, not a gate.** Under D3 (founder, 2026-11-17, recorded on E11.6-05) the founder accepted the legal risk, so these clauses do not block a later ticket. Three points D3's recorded wording did not mention explicitly:

- the terms name **headless browsers** among the banned means;
- they name **getting around "blocks or other measures that protect the site"**, which describes running fingerprint evasion against the bot checkpoint (E11.6-04, decision 2);
- they warn that the source **"may block anyone who breaks these rules, without notice"**.

Elsewhere the page says the source's own prices "come from each service's official pricing pages".

## The parser dependency

**`htmlparser2` 10.1.0 (MIT), as a direct dev dependency.** It is already installed at that version, through `mailparser` → `html-to-text`, so it adds no code to the tree. It ships nothing to the browser, and the tool never ships in the image. It is a streaming parser with no DOM emulation, enough to read:

- the link lists;
- the `#unavailable` section;
- the plan rows' visible text;
- the `<script>` contents (JSON-LD, and the `self.__next_f.push` strings).

The JSON-LD and the push strings are then plain `JSON.parse` of strings. Prices are never parsed this way. The `official` objects need a small tokenizer that keeps each number's text, which is code, not a dependency. Nothing in the extraction needs Playwright, so the adapter's tests run on the fixtures without a browser.

## Proposed changes to later tickets (for founder decisions; none applied)

1. **E11.6-04 — block the browser's own extra requests.** Make the fetcher abort every request except the top-level document and what the checkpoint needs. That means Next.js prefetches (`?_rsc=`, `next-router-prefetch`), images and fonts. Otherwise one page load makes 10–13 more page-level requests, in parallel, and "at most one page is ever loading" fails against the real source. Its acceptance criterion should count the requests the browser makes, not only the pages the tool opens.
2. **E11.6-04 — no conditional requests.** The pages change at least weekly, and a fresh context has nothing to revalidate. Drop any `ETag`/`Last-Modified` work. E11.6-07's run log would then record "not modified" as always 0, or drop that count.
3. **E11.6-05 — the extraction sources above.**
   - Country page: the HTML lists, cross-checked against the JSON-LD `ItemList`.
   - Country × service page: the embedded `official`/`usd` props and row keys, `Dataset.dateModified` and the visible text.
   - Price moves: the embedded `rows`.

   `source_verified_at` is per service and country, not per plan. The parser reads amounts from the number's text, never through a float.
4. **E11.6-05 — map "No price shown" labels.** "Not verified yet" → `source_no_price`. "Not available here" → also `source_no_price`, with the label kept in `notes`. It must never become `not_offered` automatically (rule 6).
5. **E11.6-06 — the market-currency rule.** Adobe in Poland and Romania, and Netflix in Romania, are priced in EUR on the source. Either keep the rule, and these three records go to `needs_review` every month, or let the founder record an allowed currency per service and market in config. A founder decision either way.
6. **E11.6-03 — the money parser's formats.** The source writes no local number formats (see the table). E11.6-03's examples `149 kr`, `11,99 €`, `23,99 zł`, `25,99 lei` and its list of thousands separators do not occur in the capture. It still needs:
   - the source's own style;
   - the no-break space after a letter symbol;
   - an ISO-code suffix;
   - `+ tax`.

   It can take the currency from `official.currency`. Whether to keep the wider list for the later `direct:<provider>` adapter is a founder call. E11.6-03 is outside E11.6-04 to 07, but it reads these findings.
7. **E11.6-07 — the request estimate.** About 172 page loads and 45–50 minutes, not about 460 and two hours, if change 1 is made.
8. **The spec — Apple TV's plan list.** No Apple TV or Amazon Prime country × service page was captured. If the founder wants any plan of theirs other than the main one, E11.6-05 sees it first on a real run.
