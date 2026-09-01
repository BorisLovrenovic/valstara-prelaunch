# Valstara pre-launch

The Valstara pre-launch waitlist site.

## Local verification

The rendered-page tests use Chromium through Playwright. Chromium runs in the
version-pinned official Playwright container, so the host does not need browser
binaries or privileged native-package installation. Docker must be running, as
it must be for the repository's database and infrastructure tests.

```sh
docker compose -f infra/compose/docker-compose.yml up -d
npm test
```
