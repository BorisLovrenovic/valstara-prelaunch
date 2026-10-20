# ADR-031: Digital-goods survey taxonomy and versioned handoff

- Status: Accepted
- Date: 2026-10-19
- Deciders: founder
- Amends: ADR-025's survey section

## Context

ADR-025's v1 category preferences describe physical goods. The launch catalogue is digital goods, and the storefront will create its navigation categories from the survey tokens. The pre-launch handoff must therefore preserve the meaning of both old and new answers.

## Decision

New `/verify` and `/me` forms use survey version `2026-10-19`. Q1 `category_preference` accepts `ai`, `subscriptions`, `software`, `gift_cards`, `game_keys`, `game_top_ups`, and `in_game_currency`, displayed as AI tools, Streaming and subscriptions, Software, Gift cards, Game keys, Game top-ups, and In-game currency. Q2 asks “How often do you buy digital goods?” with the existing four answers unchanged.

Keep ADR-025's `2026-09-08` set for submissions from forms rendered before deployment. A version change does not rewrite a stored response. An explicit re-answer retains the existing audited replacement behaviour. No campaign data exists yet, so no backfill or schema migration is needed; `subscriber.category_preference` is unconstrained `text[]`.

The launch customer export includes `category_preference` and nullable `survey_version`, read from `survey_response.version` in the same snapshot. The accepted category tokens are the union of the v1 and v2 sets, interpreted by `survey_version`. A person with no response exports a null version; an explicit skip has a version and a null category preference. The admin CSV contract remains unchanged.

The `survey_completed` analytics property `question_set_version` accepts both versions. It carries no category answer or personal data.

## Consequences

The storefront must recognise the union of v1 and v2 tokens when importing customer metadata and use the paired version to interpret them. Provider categories in E11.5-04 use v2 tokens. The `survey.enabled` flag continues to skip questions when off.
