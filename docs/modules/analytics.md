# Module: analytics

Kind: cross-cutting service. Implements ADR-007.

## Responsibility
A registered event schema and cookieless emission, client-side and server-side.

## Data owned
None. The event registry is code.

## Exposed interface
```ts
interface AnalyticsService {
  track<Name extends ServerEventName>(event: Name, props: EventProps<Name>): Promise<void>
}
```

## Rules
- **One registry covers client and server events**, each tagged by source. `page_view` is client-sourced with exactly `website`, `hostname`, `url`, `referrer`, `title`, `language`. There is no server view event: the landing page is edge-cached, and a server count would undercount. The E10-01 emitter's payload keys are checked against the registry.
- **No property may carry an email address, referral code, IP address, or any value identifying one person.** A schema test asserts this over the whole registry, including `page_view`. Server-side values are finite categories or booleans; raw UTM values are never emitted.
- Server `track()` copies caller properties into a plain snapshot, validates that snapshot, and sends only that snapshot; caller mutations after the call cannot change the collector payload.
- **An unregistered event or a client-sourced event passed to server `track()` throws in development and is dropped in production.** Invalid server properties follow the same rule. Development catches mistakes; production never breaks a response over telemetry.
- **`track()` never blocks a response and is never retried into a failing collector.** Losing analytics is free; delaying a signup is not.
- Server events use a fixed, non-personal User-Agent. Pinned Umami 3.3.0 silently discards Node's default bot-classified User-Agent with a 200 `beep/boop` response; the collector contract test requires a recorded event, not only an HTTP success.
- **Submit → verify → refer is computable from server events alone.** The view step uses the client `page_view`; view-based rates are labelled estimates because ad-blocker loss inflates them. The E10-05 admin view uses the same label for any view-based rate.
- **E10-03 founder decision, 2026-10-06:** `source_bucket` uses trimmed, lower-cased `utm_medium` first: `email|newsletter` → `email`, `social` → `social`, `cpc|ppc|paid|paid_social|display` → `paid`, `organic` → `organic`, `referral` → `referral`, unknown → `other`. With no medium, a valid signed ref → `referral`; otherwise any other UTM → `other`; otherwise → `direct`. The validated ref-presence bit is stored on signup for the later verification event, even when attribution is flag-off. `utm_source` is never a classifier. Raw UTM values never enter events. This order and every mapped value are table-tested.
- **E10-03 founder decision, 2026-10-06:** Emit only after the underlying state transaction commits. `signup_submitted` is for a new row, `verified` for its first verification, `referral_confirmed` for a new confirmed edge, and `giveaway_entered` for an inserted entry. `survey_completed` is once per subscriber on the first answered save; skips and replacements do not count, but skip then answer does. `unsubscribed` is once per person-initiated effective consent withdrawal or waitlist leave, with one event for a leave even if it also suppresses; no replay, no-op or provider bounce/complaint event. `source_template` is the originating finite template or `member_status` for `/me`. The survey's durable first-answered marker preserves once-only behaviour across later replacements.
- **No cookie, no `localStorage` identifier, no third-party request.** Asserted by an automated check over a rendered page — this is the property that removes the consent banner, and it is worth a test rather than a promise.
- UTM capture is server-side on the rendering request, consistent with referral capture.

## Dependencies
Umami's collection endpoint. Nothing else.

## Contract tests
Registry-wide personal-data assertion including `page_view` · unregistered and client-sourced event behaviour in both modes · a failing collector does not affect a response · emitter payload-key match · rendered-page check finds no cookie, no storage identifier and no third-party request · submit → verify → refer reconstructable from server events only.
