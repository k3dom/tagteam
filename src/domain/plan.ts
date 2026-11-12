import { Array, Match, Number, Option, pipe, Predicate, Schema } from 'effect'

import type * as Login from '#/domain/login.ts'

/** A Claude subscription, by how much usage it includes compared to Pro. */
export const Plan = Schema.Literals(['pro', 'max-5x', 'max-20x'])
export type Plan = typeof Plan.Type

export const label = (plan: Plan): string =>
  Match.value(plan).pipe(
    Match.when('pro', () => 'Pro'),
    Match.when('max-5x', () => 'Max 5x'),
    Match.when('max-20x', () => 'Max 20x'),
    Match.exhaustive
  )

/** Percentage of a limit at which tagteam switches away, by plan. */
export type Thresholds = { readonly [P in Plan]: number }

// The same few minutes of work take a smaller share of a larger plan's
// limits, so larger plans can run closer to them.
export const defaultThresholds: Thresholds = {
  pro: 90,
  'max-5x': 95,
  'max-20x': 97,
}

const MaxTier = Schema.TemplateLiteralParser([
  'default_claude_max_',
  Schema.FiniteFromString,
  'x',
])

/**
 * The plan of a login's account, read from the rate limit tier Claude Code
 * stores with it. A seat's own tier comes before its organization's, and the
 * tier in the credentials, which dates from the login, comes last. Unknown
 * tiers count as Pro, the plan with the least to spare.
 */
export const of = (login: Login.Login): Plan =>
  pipe(
    [
      login.oauthAccount['userRateLimitTier'],
      login.oauthAccount['organizationRateLimitTier'],
      login.credentials.claudeAiOauth['rateLimitTier'],
    ],
    Array.findFirst(Predicate.isString),
    Option.flatMap(Schema.decodeUnknownOption(MaxTier)),
    Option.match({
      onNone: (): Plan => 'pro',
      onSome: ([, multiplier]) =>
        Match.value(multiplier).pipe(
          Match.when(Number.isGreaterThanOrEqualTo(20), (): Plan => 'max-20x'),
          Match.when(Number.isGreaterThanOrEqualTo(5), (): Plan => 'max-5x'),
          Match.orElse((): Plan => 'pro')
        ),
    })
  )
