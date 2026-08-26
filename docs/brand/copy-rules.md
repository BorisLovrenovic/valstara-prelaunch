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

Transcribed from **`docs/brand/identity-guidelines.md` §3.2 — LOCKED**. **E1-05 seeds `scripts/forbidden-copy.json` from this table**, and the scan runs over `src/copy/`, `src/content/` and every `.astro` file.

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
- **The giveaway** — every claim on the site matches the rules page for that jurisdiction. Prize, odds basis, entry methods including AMOE, draw date, and the promoter's identity.
- **Data** — describe what actually happens: what is collected, who it reaches, how long it is kept. **Never "we never share your data"** — it necessarily reaches the email providers.
- **Trustpilot** — the profile is claimed and linked. **No rating is displayed until the review count justifies it.** A three-review score signals "unproven" more loudly than no score.
- **The guarantee and sourcing** — stated only as the store documentation states them. **This repository does not author guarantee terms**, and a page that paraphrases them is a defect.

## Failure copy
Plain, specific, no apology theatre, no vendor names, no machinery terms.

> "We can't take signups right now — try again in a few minutes."
> not "Database connection error."

> "That link has expired — we've sent a new one."
> not "Invalid token."

## Email copy
Subject lines are descriptive, not curiosity-baiting. The verification mail's only job is to get one click, so it says what it is in the first line. **Every mail carries a one-click unsubscribe and a plain-text alternative**, and the unsubscribe is as easy as the signup was.
