# Attribution Export Schema

Status: authoritative. Built by E11.7-14. **This file is the schema `npm run export:attribution` writes, and `test/attribution-export.test.ts` validates every record of a real export against the tables below:** every field listed here is present in every record, no other field exists, and each value matches its type. The hand-over contract the main platform imports under, with the meaning of each field, is in [`docs/ops/launch-cutover.md`](../ops/launch-cutover.md#the-attribution-hand-over-e117-14).

## The command

```
DATABASE_URL=<waitlist database> npm run export:attribution -- --actor=<operator> --output=<new directory>
```

It creates `<new directory>` (it refuses one that exists) with mode `0700` and writes five files into it, each `0600`:

| File | Holds |
|---|---|
| `attribution.json` | The whole export as one JSON document |
| `partners.csv` | The `partner` records |
| `referrals.csv` | The `referral` records |
| `coupons.csv` | The `coupon` records |
| `welcome_discounts.csv` | The `welcome_discount` records |

The command prints the four record counts. A failure removes the directory, so no partial export remains. It writes no database row except one `export.run` audit record (`subjectType: 'attribution_export'`, the actor, the four counts, the computed expiry and the page size), committed before the first byte; an export that cannot be audited writes nothing.

**Idempotent.** Every record comes from one repeatable-read, read-only database snapshot, in id order, in pages of at most 500 rows. The output holds no clock reading, run identifier or other generated value, so **two exports of an unchanged database are byte-identical.** The coupon and welcome-discount expiry is computed from configuration (`couponLadder.publicLaunchDate` and `expiryYears` in `src/server/referral/config.ts`), not from the clock: set the real launch date before export.

**Who is in it.** Only people in the E11-06 customer export set: subscribers with status `verified` whose normalised address is not suppressed (`docs/data/model.md#the-launch-day-handoff-contract`). A pending, expired, unsubscribed, bounced, disqualified, erasure-pending or erased person never appears, and nobody is counted before they confirm (`AGENTS.md` rule 2).

- **Partners:** every partner in `active`, `paused` or `terminated` (a signed contract) whose personal data is not purged and whose member record is in the set. Applications that never reached a contract are not exported.
- **Referrals:** every edge in state `confirmed` whose referrer and referred person are both in the set, partner and member edges alike. **A voided edge is exported with `voided = true`, never dropped.** Edges still waiting on the referred person's confirmation (`attributed`) and edges rejected by fraud review are not exported.
- **Coupons:** every `held` referral coupon whose owner is in the set. A `void` coupon is not exported, and no coupon is ever `settled` (ADR-012).
- **Welcome discounts:** a friend in the set whose earned welcome discount no referral record carries: the friend-owned entitlement kept after their partner's erasure (D-058, `retained_partner_entitlement`), or a non-voided partner edge whose partner is outside the set. These records carry no partner, code or edge.

**A friend's welcome discount appears exactly once:** on their exported partner edge, or as a `welcome_discount` record, never both.

## Types

| Type | A value is |
|---|---|
| `uuid` | A lower-case UUID string |
| `string` | A non-empty string |
| `email` | A non-empty string containing `@` |
| `code` | A referral code: 4 to 16 of `A`–`Z` and `0`–`9` |
| `country` | An ISO 3166-1 alpha-2 code, two upper-case letters |
| `date` | A calendar date, `YYYY-MM-DD` |
| `timestamp` | An RFC 3339 UTC instant with milliseconds, `YYYY-MM-DDTHH:MM:SS.sssZ` |
| `integer` | A whole number |
| `boolean` | `true` or `false` |
| `true` | Always `true` |
| `enum(a, b)` | Exactly one of the listed strings or numbers |

A field marked nullable may be `null`; any other field never is.

## `attribution.json`

One JSON object, with these keys in this order:

| Key | Value |
|---|---|
| `format` | `"valstara-attribution-export"` |
| `version` | `1`. Raised by any change to the fields below |
| `public_launch_date` | The configured public-launch date, `YYYY-MM-DD`, from which every expiry is computed |
| `counts` | `{"partners", "referrals", "coupons", "welcome_discounts"}`, each the number of records in that section |
| `partners` | Array of `partner` records |
| `referrals` | Array of `referral` records |
| `coupons` | Array of `coupon` records |
| `welcome_discounts` | Array of `welcome_discount` records |

Each record is a JSON object whose keys are the fields of its table, in table order. Each array is in ascending order of the record's first field.

## CSV encoding

Each CSV file has a header row of the field names, in table order, then one row per record in the same order as the JSON array. Rows end in CRLF. A cell containing a comma, a double quote, a carriage return or a line feed is quoted, with inner quotes doubled. A `null` is an empty cell. Booleans are `true` and `false`; integers are decimal; timestamps and dates are written as in the JSON. No `string`, `email` or `code` value is ever empty, so an empty cell always means `null`.

## `partner` records

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `partner_id` | `uuid` | no | `partner.id` |
| `subscriber_id` | `uuid` | no | The partner's member record |
| `legal_name` | `string` | no | `partner.full_name` |
| `email` | `email` | no | The member record's address as entered |
| `email_normalised` | `email` | no | The customer import key |
| `country` | `country` | no | `partner.country_of_residence` |
| `partner_type` | `enum(standard, student_ambassador, creator)` | no | |
| `status` | `enum(active, paused, terminated)` | no | |
| `partner_code` | `code` | no | The registered partner code |
| `member_code` | `code` | no | The partner's own member referral code |
| `approved_at` | `timestamp` | no | When the founder approved the application, from its `partner.approved` audit record |
| `contract_signed_at` | `date` | no | |
| `contract_version` | `string` | no | |
| `founding_partner` | `true` | no | Every partner accepted during the pre-launch campaign |
| `display_name` | `string` | yes | The partner's optional dashboard display name |

## `referral` records

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `edge_id` | `uuid` | no | `referral_edge.id` |
| `referred_subscriber_id` | `uuid` | no | |
| `referred_email` | `email` | no | As entered |
| `referred_email_normalised` | `email` | no | The referred customer's import key |
| `referrer_subscriber_id` | `uuid` | no | |
| `referrer_email_normalised` | `email` | no | The referrer's customer import key |
| `referrer_type` | `enum(member, partner)` | no | `partner` exactly when the edge is credited to a partner |
| `partner_id` | `uuid` | yes | Set exactly on a partner edge, and then names a `partner` record |
| `partner_code` | `code` | yes | Set exactly on a partner edge |
| `attribution_method` | `enum(link, code, retroactive)` | no | |
| `signup_at` | `timestamp` | no | When the referred person signed up |
| `confirmed_at` | `timestamp` | no | When the referred person's verification confirmed the edge |
| `voided` | `boolean` | no | |
| `voided_at` | `timestamp` | yes | Set exactly when `voided` |
| `void_reason` | `string` | yes | The founder's reason; set exactly when `voided` |
| `referred_access_window` | `enum(wave-1, wave-2, wave-3, wave-4)` | no | The referred person's early-access wave |
| `referred_early_access` | `boolean` | no | `referred_access_window = wave-1` |
| `welcome_discount_pct` | `enum(10, 15, 20)` | yes | Set exactly on a partner edge that is not voided |
| `welcome_discount_expires_at` | `timestamp` | yes | Set exactly with `welcome_discount_pct` |

## `coupon` records

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `coupon_id` | `uuid` | no | `referral_coupon.id`, the same ID as the E11-06 `held_coupon` record |
| `subscriber_id` | `uuid` | no | The owner |
| `email_normalised` | `email` | no | The owner's customer import key |
| `coupon_number` | `integer` | no | 1, 2 or 3, in ladder order |
| `percent` | `integer` | no | 5 to 30 in steps of 5 under the configured ladder |
| `state` | `enum(held)` | no | Always `held` |
| `expires_at` | `timestamp` | no | Five years after the configured public-launch date |

## `welcome_discount` records

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `subscriber_id` | `uuid` | no | The friend who owns the discount |
| `email` | `email` | no | As entered |
| `email_normalised` | `email` | no | The friend's customer import key |
| `welcome_discount_pct` | `enum(10, 15, 20)` | no | Fixed when the friend signed up |
| `wave_one` | `true` | no | The friend keeps the wave-1 place the discount came with |
| `expires_at` | `timestamp` | no | Five years after the configured public-launch date |
