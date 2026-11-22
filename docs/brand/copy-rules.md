# Copy Rules — Enforceable

Status: authoritative, derived from the LOCKED brand guidelines. **These are scanned in CI.** A forbidden string reaching production is a **defect**, not a style disagreement — which is why this lives in a greppable file.

## Voice
Plain, precise, unhurried. **Sentence case everywhere.** Active voice — *"We'll email you a link,"* never *"a link will be sent."* Specific over clever. **No exclamation marks.** **No manufactured urgency.**

## Never build

The patterns that define this category's worst actors.

Every hosted waitlist tool sells these as features. LaunchList sells **ranking inflation** by name. Shipping one of them puts this brand in the bracket it exists to escape, and the audience — a suspicious buyer — reads them as exactly the tell they are scanning for.

| Never | Why |
|---|---|
| **Countdown timers** | Manufactured urgency on a campaign with no deadline is a lie with a clock on it |
| **Inflated or offset positions** | "You're #4,182" when 300 people have signed up. **The count shown is the count in the database** |
| **Fake stock or spot scarcity** | There is no scarcity in a waitlist |
| **Exit-intent popups** | |
| **Pre-checked consent or opt-in boxes** | Unlawful in the target markets, and it reads as it is |
| **A visible position before verification** | An unverified row has no honest position |
| **Dark-pattern unsubscribe** | One click, no confirmation maze, no "are you sure you want to miss out" |

## Never use — CI-scanned

Transcribed from **`docs/brand/identity-guidelines.md` §3.2 — LOCKED**. **E1-05 seeds `scripts/forbidden-copy.json` from this table**, and the scan runs over `src/copy/`, `src/content/`, `packages/price-index/copy/` (the price-index report templates, from E11.6-09) and every `.astro` file.

Two CI scans keep copy honest, both in `scripts/ci/security-gates.mjs`:

- **Forbidden-copy scan** — no never-use string ships. Its failure names the replacement to write instead.
- **Inline-prose scan** (E2-08) — enforces "no customer-visible prose inline in markup". It parses every `src/**/*.astro` component and flags literal template text **and literal values of the customer-visible attributes** (`alt`, `title`, `placeholder`, `aria-label`, `aria-description`, `aria-placeholder`, `aria-roledescription`, `aria-valuetext`) — assistive-technology copy is prose inline in markup just as visible text is. The sanctioned path is a string in the copy layer (`src/copy/`, or `src/content/` for prose) rendered through an `{expression}`. Strings inside `<script>` and `<style>` are not copy and are ignored. Its failure tells the developer to move the string into the copy layer.

| Never use | Use instead |
|---|---|
| cracked · hacked · leaked | sourced · verified supplier |
| black market · grey market · underground | regional pricing · promotional pricing |
| no refunds · all sales final | warranty · replacement · refund |
| dirt cheap · insane deal · unbeatable | below list price |
| shared account · stolen · bypass | account · licence · key · credit |
| **instant delivery · immediate access** | **delivered within 24 hours** |
| digital products | **digital goods** |

**"Instant delivery" is the one that matters most.** It is what this category's worst actors claim and frequently fail to honour, and the guarantee's first promise exists precisely to say the real number instead. It must never ship.

Three rules govern the list itself, and they apply whatever the transcribed terms turn out to be:

1. **The left column is what this category's worst actors say.** Using their vocabulary puts us in their bracket, which is the entire strategic risk.
2. **Every entry names a replacement**, so the scan failure tells a developer what to write instead of only what not to.
3. **Adding a term is a copy decision, removing one is a brand decision.** An agent may add; only the founder removes.

## Claims that must stay true

A pre-launch page makes fewer claims than a storefront, and each one is load-bearing because it is being read by someone deciding whether this is a scam.

- **Timing** — say what is actually known. If the launch window is a range, publish the range. **Never a date the campaign cannot hold.**
- **Numbers** — any count shown (signups, referrals, positions) is the real number from the database. **A rounded or "approximate" figure must be labelled as one.**
- **Referral rewards (E11.7-04)** — the coupon ladder, wave 1 and early access are stated only from configuration (`couponLadder`, `waveOneReferralThreshold`, `waveOneEarlyAccessMonth`, the wave-1 band), through `src/server/referral/ladder-presentation.ts`, never as literal figures in copy. **Every mention of a coupon carries its first-order condition** (ADR-012): coupons are usable once one of the member's referred friends places a first order, for the configured years after launch. The retired reward ("15% off at 3 referrals", a wave upgrade, a referral tier, the 90-day window) is stated nowhere, which `test/ladder-copy-surfaces.test.mjs` scans the copy layer, the content files, the rendered pages and the referral emails for. The only scarcity wording allowed is the founder-approved line in `docs/prerequisites/valstara-prelaunch-growth-decisions.md`, and it is not shown today.
- **The giveaway** — every claim on the site matches the current global rules page (ADR-026). Prize and its value, "no purchase necessary", 18+, one prize per person, the odds wording, the draw date, and the promoter's identity.
- **Data** — describe what actually happens: what is collected, who it reaches, how long it is kept. **Never "we never share your data"** — it necessarily reaches the email providers.
- **Trustpilot** — linked; no widget or rating pre-launch. A three-review score signals "unproven" more loudly than no score.
- **Provider marks** — show only P8-confirmed launch providers. A banner carries no price, discount, product count, availability date or stock claim. The site footer states that the marks belong to their owners and that Valstara is an independent seller without affiliation or endorsement (ADR-032).
- **Price pages (E11.6)** — every figure is a published record, a `changes.json` entry or a Valstara price from `config/valstara-prices.json`, never a converted price and never the source's USD figure. A price is shown in its own market's currency: on a European page, a US price can appear in USD only as the United States' own list price. A rank ("the 3rd most expensive of our 20 markets") counts only the markets the index ranks. A Valstara saving says "below list price", compares like for like or states its basis in words, and is floored to one decimal so it never overstates; a Valstara price that is not at least 0.1% below list is not shown, so the figure never reads "0.0% below list price", and none is shown while `prices.valstara_comparison` is off (E11.6-11). Provider and plan names are the catalogue's, unaltered ("Spotify Premium — Individual"). **The methodology at `/price-index` (E11.6-13)** opens with the founder's D4 wording and says nothing it cannot prove: each sentence is traced to the setting, gate rule or tested behaviour it describes, a changed setting with an unchanged sentence fails `test/price-index/price-index-methodology.test.ts`, and no sentence says the prices are read from official pages (they come from a public listing, checked by hand against the providers' own pages where needed) or names the data source.
- **The guarantee and sourcing** — stated only as the store documentation states them. **This repository does not author guarantee terms**, and a page that paraphrases them is a defect.

## Failure copy
Plain, specific, no apology theatre, no vendor names, no machinery terms.

> "We can't take signups right now — try again in a few minutes."
> not "Database connection error."

> "That link has expired — we've sent a new one."
> not "Invalid token."

## Email copy
Subject lines are descriptive, not curiosity-baiting. The verification mail's only job is to get one click, so it says what it is in the first line. Verification and verification-reminder mail carry no status-page link before the address is verified (founder-authorised 2026-09-28). **Every mail carries a one-click unsubscribe and a plain-text alternative**, and the unsubscribe is as easy as the signup was.

Each template has a hidden preheader in the copy layer: one plain sentence that describes the message, never a teaser, and never a repeat of the subject (E11.5-11). It appears only in the inbox preview, so the verification mail's first line is still the first line of its body and its plain text. Every mail's footer carries the §3.4 legal line and `support@valstara.com`, shared with the site footer from `src/copy/layout.ts`.
