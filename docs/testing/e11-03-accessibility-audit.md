# E11-03 accessibility audit

Date: 2026-10-08; spoken pass completed 2026-10-09. Target: WCAG 2.2 AA. Audited the built local site in the version-pinned Playwright Chromium container against an isolated migrated PostgreSQL database. The signup request used [Cloudflare's documented always-pass test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/), with its browser widget callback simulated; the server still validated the dummy token through Siteverify. No live email was sent. The verification link was derived from the queued verification token in the disposable database and opened in the same browser journey.

## Evidence

| Criterion | Reproducible check | Result |
|---|---|---|
| Keyboard-only signup through verification | `npm run test:a11y`, `keyboard-only signup and verification expose errors and reach verified state` | Tab reaches the email input and submit control; Enter submits. The empty-email error focuses the input. A form-level error focuses its alert. A subsequent real signup creates a pending row, its email token opens an inert confirmation page, and Enter verifies the row. The page exposes the status link. |
| Form errors exposed for announcement and associated without colour | The same browser test checks the accessibility snapshot, `role="alert"`, `aria-invalid`, `aria-describedby`, focus and axe after each error; the Orca pass below checks spoken output | The email error has readable text and a border as well as its association; the form-level alert has readable text and receives focus. Both error states pass axe and were spoken by Orca. |
| Contrast at rendered sizes | `npm run test:a11y`, `signup and verification text clears AA contrast at rendered font sizes in both themes` | Computed text colour, nearest opaque rendered background, font size and weight are read from the browser, then checked against 4.5:1 for ordinary text and 3:1 for large text. This covers signup text, the visible validation error, verification confirmation and recovery text. Lowest measured ratio: light signup/verification 5.30:1; dark signup 7.33:1; dark confirmation 7.33:1; dark recovery 7.52:1. |
| Reduced motion | `npm run test:a11y`, `every animation is disabled under prefers-reduced-motion` | The browser inspects computed animation and transition properties over every element of each enumerated rendered route with reduced motion enabled. No active animation or transition was found. |
| Baseline | `npm run test:a11y`, `every built page has zero WCAG 2.2 AA violations in both themes` and `tab order follows the visual reading order with no focus trap` | Both passed on the current route inventory. |

### Spoken screen-reader pass, 2026-10-09

Ran Orca 46.1 with Speech Dispatcher 0.12.0-rc2 and eSpeak NG against **headed** Playwright Chromium in Xvfb, with Chromium's `--force-renderer-accessibility` flag. The environment was an isolated container built from the same pinned Playwright image used by `npm run test:a11y`; the repository gained no dependency. Keyboard Tab and Enter events drove the rendered local form. The browser's test-only Turnstile callback and mocked signup responses exposed an empty email, a rate-limit form error, a server email error, and an accepted response without sending mail or storing a subscriber. This pass supplements the real database and verification journey in the test above.

Orca's `--debug-file` speech output recorded these utterances, in order of the corresponding interaction:

| Keyboard action | Spoken output |
|---|---|
| Tab to email input | “Email address entry you@example.com required.” Then the confirmation-link hint. |
| Enter on submit with empty email | “invalid entry.” Then “We'll email you a link to confirm your address. Enter your email address.” |
| Enter on submit with a simulated rate limit | “Too many attempts — try again in a few minutes.” |
| Enter on submit with a simulated invalid-email response | “Enter a valid email address.” |
| Enter on submit with an accepted response | “Thanks — any next step will arrive by email.” |

The Speech Dispatcher output was captured from a PulseAudio monitor as 44.1 kHz, two-channel PCM. `ffmpeg -f s16le -ar 44100 -ac 2 -i speech.raw -af volumedetect -f null -` measured −15.5 dB mean and 0.0 dB peak, confirming that speech synthesis produced audio rather than only debug text. The Orca log recorded each phrase as `SPEECH OUTPUT` followed by `SPEECH DISPATCHER: Speaking`.

To repeat the spoken check on a Linux desktop, start the local stack with `docker compose -f infra/compose/docker-compose.yml up -d`, start Orca with `orca --debug-file /tmp/valstara-orca.log`, and open the local site in headed Chromium with accessibility enabled. Tab to the email and submit controls; press Enter with the email empty, then enter an address and repeat with a simulated signup error and accepted response. Inspect actual speech and use `rg 'SPEECH OUTPUT:' /tmp/valstara-orca.log` to match the announced label, hint, errors, and status to the actions. The repeatable browser/database journey and its assertions are `npm run test:a11y`.

## Finding and fix

The signup island hid the focused submit control after an accepted response, leaving focus outside the completed interaction. Asynchronous form-level errors also left focus behind after the submit control was disabled. `src/islands/SignupForm.astro` now focuses the status or alert, each with `tabindex="-1"` so the normal Tab order is unchanged. The keyboard journey asserts both focus destinations. The success-focus assertion failed before the change and passed afterward.
