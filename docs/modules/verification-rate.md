# Module: verification-rate

Kind: cross-cutting service. Implements E3-10.

## Responsibility

Calculate the verification rate for a rolling signup cohort, compare it with a
rolling baseline, report a P1 collapse, and expose an aggregate-only health
result for E10-05's authenticated admin route.

## Exposed interface

```ts
interface VerificationRateMonitor {
  health(): Promise<VerificationRateHealth>
  run(): Promise<VerificationRateHealth>
}
```

`run()` emits a P1 alert when the current cohort has reached the configured
minimum and its verification rate has fallen by at least the configured relative
percentage below the baseline. `health()` does not emit an alert.

## Rules

- The rate is `verified / signups`, never a verification count.
- The default current cohort is the preceding 24 hours; the baseline is the
  seven days before that cohort. All four monitoring values are validated
  environment configuration.
- A cohort below the configured minimum is `warming_up` and cannot alert.
- Provider reporting is aggregate-only: Gmail, Microsoft, GMX, Web.de and
  other. It carries no address, token, IP address or other personal data.
- E10-05 owns `GET /api/admin/health` and its MFA boundary. It consumes this
  module's result; this module creates no route.

## Contract tests

A simulated conversion collapse raises P1 · a traffic-volume drop with an
unchanged rate does not alert · a cold cohort is warming up and does not alert ·
provider groups remain aggregate-only.
