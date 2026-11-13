# Module: flags

Kind: cross-cutting service. Implements ADR-023.

## Responsibility
Campaign flags, so a mechanic can be switched off during an incident without a deploy.

## Data owned
`campaign_flag`.

## Exposed interface
```ts
interface FlagService {
  isEnabled(key: FlagKey): Promise<boolean>            // DB override, else the code default
  set(key: FlagKey, enabled: boolean, actor: string): Promise<void>
  list(): Promise<Flag[]>
}
```

## Rules
- **Every flag is registered in code with a fail-safe default.** An unregistered key **throws** — never a silent `false`.
- **A lookup failure returns the code default.** A flag-service problem is safe, never fail-open.
- Reads are cached in-process for **five seconds**; **`set()` invalidates the local process immediately**. Other processes observe the database override on their next read after cache expiry, so the documented worst-case propagation delay is **five seconds**. A flag whose effect is invisible for an unknown period is not an incident lever.
- **`leaderboard.public` off must remove the section, not break it** — drilled, not assumed.
- Every change is audited with an actor.

## Operator CLI
`src/server/flags/cli.ts` is the only way an operator sets a flag: `list`, and `set <key> on|off --actor <name>`. It refuses a missing actor or an unregistered key before touching the database, and every change goes through `set()`, so it is audited with the named actor. It runs inside the production image; the command is in `docs/ops/runbook.md#setting-a-campaign-flag`. There is no admin HTTP route for flags.

## Dependencies
`db`, `audit`.

## Contract tests
Unregistered key throws · database unavailable returns the code default · every registered flag has a declared default, asserted over the registry · `set()` takes effect within the TTL · flipping `leaderboard.public` removes the section and returns `503` from the route.
