# Module: admin-auth

Kind: cross-cutting security boundary. Founder-authorised 2026-09-16.

## Responsibility

Protect every `/api/admin/*` route with the same two stateless factors: a
server-held bearer credential and a six-digit TOTP. Successful authentication
places the fixed `admin.operator` actor in request locals so downstream action
routes can write a human actor into the append-only audit log.

## Contract

- Both factors are required on every request; either factor failing produces
  the same `401 unauthorized` response.
- TOTP follows RFC 6238 with HMAC-SHA-1, a 30-second step, six digits and one
  adjacent step of clock-skew tolerance.
- Credential comparisons and TOTP comparisons are constant-time.
- The boundary is stateless: no password, cookie, browser storage, session,
  user system or permission matrix exists.
- Authentication responses use `Cache-Control: no-store` and contain no
  credential, TOTP, token, raw IP address or verifier detail.
- Every route file under `src/pages/api/admin` has an exact entry in the
  admin-route registry. Non-GET registrations declare that audit is required.

## Configuration

`ADMIN_CREDENTIAL` is at least 32 printable non-space ASCII characters.
`ADMIN_TOTP_SECRET` is an uppercase, unpadded Base32 seed with at least 160 bits.
Both fail boot when absent or malformed, use disposable values locally and in
CI, and use separately generated live values from the production secret
manager. Neither value is stored in PostgreSQL or committed.
