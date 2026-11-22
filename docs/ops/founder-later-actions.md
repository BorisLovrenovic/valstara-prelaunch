# Founder later actions

Status: running list. These are things the founder must do **later**, after the work that needs them has shipped. Each one is easy to forget because nothing breaks while it is undone. A feature simply stays off.

Check this list before launch, after launch, and whenever a ticket ships something that is switched off by default. Add new items at the bottom. When an item is done, move it to **Done** with the date.

---

## Open

*(Nothing yet.)*

## Deferred

### Dedicated Brevo partner sync

D-056 defers this work until a founder-authorised plan change establishes a verified provider-side ordering or cancellation guarantee. The E11.7-06 CSV is for founder review only. Manual Brevo uploads, including uploads from previously saved files, are retired.

The release blocker is an upsert that Brevo receives before the response is lost. In the real PostgreSQL reproduction, the provider simulator accepts the upsert, loses the response and delays applying the write. Signed erasure confirmation commits and fulfilment deletes the contact. The delayed write then recreates the contact. The deferred regression must exercise that ordering and assert that the contact stays absent.

Carry forward the sync requirements and tests on the E11.7-06 plan entry. The on-demand tests must also prove that the operator audit commits before provider dispatch and that final counts remain recoverable if the completion audit fails. The retry test must prove that failed contacts yield to waiting candidates and remain eligible for retry. The prior sync tests are in `test/partner-brevo-sync.test.ts` at `f8a8fdb`.

---

## Done

*(Nothing yet.)*
