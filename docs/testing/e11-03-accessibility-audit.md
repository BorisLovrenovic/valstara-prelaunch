# E11-03 accessibility audit

Date: 2026-10-08. Target: WCAG 2.2 AA. Audited the built local site in the version-pinned Playwright Chromium container against an isolated migrated PostgreSQL database. The signup request used [Cloudflare's documented always-pass test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/), with its browser widget callback simulated; the server still validated the dummy token through Siteverify. No live email was sent. The verification link was derived from the queued verification token in the disposable database and opened in the same browser journey.

## Evidence

| Criterion | Reproducible check | Result |
|---|---|---|
| Keyboard-only signup through verification | `npm run test:a11y`, `keyboard-only signup and verification expose errors and reach verified state` | Tab reaches the email input and submit control; Enter submits. The empty-email error focuses the input. A form-level error focuses its alert. A subsequent real signup creates a pending row, its email token opens an inert confirmation page, and Enter verifies the row. The page exposes the status link. |
| Form errors exposed for announcement and associated without colour | The same browser test checks the accessibility snapshot, `role="alert"`, `aria-invalid`, `aria-describedby`, focus and axe after each error | The email error has readable text and a border as well as its association; the form-level alert has readable text and receives focus. Both error states pass axe. Spoken announcement remains to be checked with a screen reader. |
| Contrast at rendered sizes | `npm run test:a11y`, `signup and verification text clears AA contrast at rendered font sizes in both themes` | Computed text colour, nearest opaque rendered background, font size and weight are read from the browser, then checked against 4.5:1 for ordinary text and 3:1 for large text. This covers signup text, the visible validation error, verification confirmation and recovery text. Lowest measured ratio: light signup/verification 5.30:1; dark signup 7.33:1; dark confirmation 7.33:1; dark recovery 7.52:1. |
| Reduced motion | `npm run test:a11y`, `every animation is disabled under prefers-reduced-motion` | The browser inspects computed animation and transition properties over every element of each enumerated rendered route with reduced motion enabled. No active animation or transition was found. |
| Baseline | `npm run test:a11y`, `every built page has zero WCAG 2.2 AA violations in both themes` and `tab order follows the visual reading order with no focus trap` | Both passed on the current route inventory. |

The browser's accessibility snapshots expose names, descriptions, error text and order to assistive technology. An actual spoken screen-reader pass was unavailable in this environment: no screen reader executable was installed, and the browser used for the reproducible checks was headless. A human pass with a screen reader remains required before this audit can be called complete.

## Finding and fix

The signup island hid the focused submit control after an accepted response, leaving focus outside the completed interaction. Asynchronous form-level errors also left focus behind after the submit control was disabled. `src/islands/SignupForm.astro` now focuses the status or alert, each with `tabindex="-1"` so the normal Tab order is unchanged. The keyboard journey asserts both focus destinations. The success-focus assertion failed before the change and passed afterward.
