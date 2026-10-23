# Valstara pre-launch

The Valstara pre-launch waitlist site.

## Local verification

The rendered-page tests use Chromium through Playwright. Chromium runs in the
version-pinned official Playwright container, so the host does not need browser
binaries or privileged native-package installation. Docker must be running, as
it must be for the repository's database and infrastructure tests.

```sh
docker compose -f infra/compose/docker-compose.yml up -d
npm run check
npm run test:changed -- <the test files your change needs>
```

`npm run check` runs lint, format, typecheck, the security scans and the build.
`npm run test:changed` runs the tests your branch affects and prints why it
picked each one. The full suite runs in CI on every pull request, split across
four parallel runners; `npm test` still runs it all locally when you need it.
See `docs/engineering/ci-cd.md#local-checks`.
