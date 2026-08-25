# Module: analytics

Kind: cross-cutting service. Implements ADR-007.

## Responsibility
A registered event schema and cookieless emission, client-side and server-side.

## Data owned
None. The event registry is code.

## Exposed interface
```ts
interface AnalyticsService {
  track(event: EventName, props: EventProps<EventName>): Promise<void>   // server-side
}
```

## Rules
- **No property may carry an email address, referral code, IP address, or any value identifying one person.** A schema test asserts this over the whole registry — it is not left to reviewer attention.
- **An unregistered event throws in development and is dropped in production.** Neither behaviour is a compromise: development catches the mistake, production never breaks a response over telemetry.
- **`track()` never blocks a response and is never retried into a failing collector.** Losing analytics is free; delaying a signup is not.
- **The funnel is computable from server events alone.** Client events add texture; ad blockers mean they cannot be the basis of anything.
- **No cookie, no `localStorage` identifier, no third-party request.** Asserted by an automated check over a rendered page — this is the property that removes the consent banner, and it is worth a test rather than a promise.
- UTM capture is server-side on the rendering request, consistent with referral capture.

## Dependencies
Umami's collection endpoint. Nothing else.

## Contract tests
Registry-wide personal-data assertion · unregistered event behaviour in both modes · a failing collector does not affect a response · rendered-page check finds no cookie, no storage identifier and no third-party request · funnel reconstructable from server events only.
