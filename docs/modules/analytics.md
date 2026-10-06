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
- **An unregistered event or a client-sourced event passed to server `track()` throws in development and is dropped in production.** Invalid server properties follow the same rule. Development catches mistakes; production never breaks a response over telemetry.
- **`track()` never blocks a response and is never retried into a failing collector.** Losing analytics is free; delaying a signup is not.
- Server events use a fixed, non-personal User-Agent. Pinned Umami 3.3.0 silently discards Node's default bot-classified User-Agent with a 200 `beep/boop` response; the collector contract test requires a recorded event, not only an HTTP success.
- **Submit → verify → refer is computable from server events alone.** The view step uses the client `page_view`; view-based rates are labelled estimates because ad-blocker loss inflates them. The E10-05 admin view uses the same label for any view-based rate.
- **No cookie, no `localStorage` identifier, no third-party request.** Asserted by an automated check over a rendered page — this is the property that removes the consent banner, and it is worth a test rather than a promise.
- UTM capture is server-side on the rendering request, consistent with referral capture.

## Dependencies
Umami's collection endpoint. Nothing else.

## Contract tests
Registry-wide personal-data assertion including `page_view` · unregistered and client-sourced event behaviour in both modes · a failing collector does not affect a response · emitter payload-key match · rendered-page check finds no cookie, no storage identifier and no third-party request · submit → verify → refer reconstructable from server events only.
