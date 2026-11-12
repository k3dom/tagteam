import { describe, it } from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'

import * as Plan from '#/domain/plan.ts'
import * as Sandbox from '#test/sandbox.ts'

const withTiers = (tiers: {
  readonly seat?: string | null
  readonly organization?: string | null
  readonly credentials?: string
}) => {
  const { oauthAccount, credentials } = Sandbox.login('someone')
  return {
    oauthAccount: {
      ...oauthAccount,
      userRateLimitTier: tiers.seat ?? null,
      organizationRateLimitTier: tiers.organization ?? null,
    },
    credentials: {
      ...credentials,
      claudeAiOauth: {
        ...credentials.claudeAiOauth,
        ...(tiers.credentials && { rateLimitTier: tiers.credentials }),
      },
    },
  }
}

describe('Plan.of', () => {
  it.each([
    {
      name: 'a personal Max 20x subscription',
      tiers: { organization: 'default_claude_max_20x' },
      expected: 'max-20x',
    },
    {
      name: 'a team seat by its own tier',
      tiers: { seat: 'default_claude_max_5x', organization: 'default_raven' },
      expected: 'max-5x',
    },
    {
      name: 'the organization over the tier stored at login',
      tiers: {
        organization: 'default_claude_max_20x',
        credentials: 'default_claude_max_5x',
      },
      expected: 'max-20x',
    },
    {
      name: 'a downgrade over the tier stored at login',
      tiers: {
        organization: 'default_claude_ai',
        credentials: 'default_claude_max_20x',
      },
      expected: 'pro',
    },
    {
      name: 'the tier stored at login when nothing newer is known',
      tiers: { credentials: 'default_claude_max_5x' },
      expected: 'max-5x',
    },
    {
      name: 'a plan above Max 20x as Max 20x',
      tiers: { organization: 'default_claude_max_50x' },
      expected: 'max-20x',
    },
    { name: 'no known tier as Pro', tiers: {}, expected: 'pro' },
  ] as const)('reads $name', ({ tiers, expected }) => {
    deepStrictEqual(Plan.of(withTiers(tiers)), expected)
  })
})
