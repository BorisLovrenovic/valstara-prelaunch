# E11-04 — Claims and copy audit

Date: 2026-10-09. Scope: current public pages, their interface copy, and transactional and weekly email templates. The two superseded rules articles are historical records: their page wrappers identify them as superseded, preserve their article hashes, and point to the current rules. The checks are `test/e11-04-claims-audit.test.mjs`, the rendered rules and SEO tests, and the existing security and copy gates.

## Claim inventory and source

| Current surface and claim | Source and check |
|---|---|
| `/`, `/about`, `/guarantee`: direct seller; sourced from verified suppliers or acquired directly; categories, prices below list, and full seller responsibility | `docs/brand/identity-guidelines.md` §§1.4–1.7 and `docs/prerequisites/p3b-trust-pages-copy.md`; approved trust prose compared in the claims test |
| `/`, `/guarantee`: the three Triple Guarantee promises, including weekday delivery within 24 hours, protection, and resolve → replace → refund | `docs/brand/identity-guidelines.md` §§2.1–2.4 and the approved P3b copy; source comparison test |
| `/legit`, `/about`, current rules: 3NITY DIGITAL LIMITED, Hong Kong registration, business number 79886556, registered address and support contact; Boris Lovrenovic as founder | `docs/prerequisites/p3b-trust-pages-copy.md` and `docs/prerequisites/p4-rules-page-draft.md`; trust source comparison and rules required-statement tests. Registry and founder facts are founder-supplied, not independently verified by this repository |
| `/` and `/about`: no promised store opening date; no waitlist deadline or manufactured scarcity | `docs/brand/copy-rules.md#never-build` and P3b; source scan and page inspection |
| Signup, verification, `/me`, leaderboard, and email: only verified people count; displayed referral totals, rank, tier and entries come from stored status or a dated snapshot, with no offset | `docs/modules/referral.md`, `docs/modules/giveaway.md`, `src/server/referral/status-presentation.ts`, `src/server/referral/ranking.ts`, `src/server/leaderboard/snapshot.ts`; existing ranking, snapshot, signup and giveaway tests |
| Signup and current rules: 18+, free entry without purchase, referral or marketing consent; one registration per person and one prize per person | `VAL-GW-LAUNCH-20261009-r1`, ADR-026 and ADR-027; claim-to-rules test and existing eligibility tests |
| Current rules and award messages: five bundles at approximately €300 each, €1,500 total, electronic delivery, substitution, winner checks, one prize per person, and the 1 April 2027 draw | Current rules and P4; rules schema, prize-limit and claim-to-rules tests. €300 is below the €449 per-prize cap; the pool checks as US$3,000 at the recorded conservative rate, below US$5,000 |
| Current rules: each eligible entry has equal weight; first-draw odds depend on a person's eligible entries divided by all eligible entries; remaining entries leave the pool after a person wins | Current rules §7, ADR-026 and `src/server/giveaway/draw.ts`; claim-to-rules and draw tests |
| Current rules: no EU or UK Article 27 representative assertion | ADR-029 and the founder-authorised 2026-10-09 revision; exact-change and rendered-page tests |
| `/`, `/privacy`, `/privacy/storage`, `/legit`: email is stored for waitlist service and processed by email providers; theme preference is the one browser-storage entry; no tracking cookies or advertising trackers | `docs/legal/compliance.md`, ADR-007, `src/server/email`, and the storage/privacy gates. The landing FAQ's former “and nowhere else” wording was removed because it exceeded the documented processor claim |
| Signup, `/me`, unsubscribe and privacy pages: optional, unticked marketing choice; withdrawal does not forfeit waitlist or entries | ADR-027, `docs/legal/compliance.md`, `src/islands/SignupForm.astro`, `src/pages/me.astro`; consent and unsubscribe tests |
| `/privacy`: retention and erasure statements, including award exception, provider deletion and backup window | `docs/legal/compliance.md` §2 and `docs/features/legal-and-dsr.md`; legal-page and DSR tests. The founder-authorised legal text is still explicitly a draft pending E11-05 review |

## Dark-pattern inventory

| Forbidden pattern in `docs/brand/copy-rules.md#never-build` | Finding |
|---|---|
| Countdown timer, fake stock or spot scarcity, exit-intent popup | None in the page, component, island or copy sources. The leaderboard's interval refreshes its real snapshot; it is not a countdown |
| Inflated or offset rank/count; position before verification | No offset or fake position in the ranking and presentation paths. Public signup response does not disclose a position; authenticated status derives counts and rank from the service |
| Pre-checked consent or opt-in | Signup marketing checkbox, survey choices and optional winner publicity checkbox render unchecked; the marketing choice is independent of entry |
| Dark-pattern unsubscribe | Email includes unsubscribe, and the unsubscribe action has no retention plea or confirmation maze; `/me` exposes a separate leave action |

The forbidden-copy gate covers `src/copy`, `src/content` and Astro markup. The E11-04 scan additionally checks the email template modules and placeholder markers. No placeholder filler was found; the explicitly labelled legal drafts are founder-authorised current copy, with review still due at E11-05. The current rules article has no representative claim. Each historical revision retains its original claim only inside its unchanged, hash-valid article and carries the approved archive notice outside it.

## Browser loading and privacy impact

The revised rules pages load the same first-party layout assets as before. The archive notice adds only HTML and a first-party link. It makes no new request, storage write or personal-data read. The landing FAQ change is text only.
