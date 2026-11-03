import { NodeServices } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import * as Rotation from '#/services/rotation.ts'
import * as Sandbox from '#test/sandbox.ts'

const { at, login, start } = Sandbox

const tick = Effect.fnUntraced(function* () {
  const rotation = yield* Rotation.Rotation.make({
    threshold: 90,
    interval: '1 minute',
  })
  yield* rotation.tick()
})

layer(NodeServices.layer)('Rotation', (it) => {
  it.effect(
    'switches to the next account once the active one nears a limit',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start.epochMilliseconds)
        const main = login('main')
        const backup = login('backup')
        const box = yield* Sandbox.make({
          live: main,
          accounts: [main, backup],
        })
        box.usage.set('main', { fiveHour: 92 })
        box.usage.set('backup', { fiveHour: 10 })
        // Claude Code refreshed the main account since tagteam stored it.
        const refreshedMain = login('main', { generation: 1 })
        yield* box.logIn(refreshedMain)

        yield* tick().pipe(Effect.provide(box.layer))

        deepStrictEqual(yield* box.claudeCode, {
          credentials: {
            ...backup.credentials,
            mcpOAuth: { linear: { accessToken: 'mcp-token' } },
          },
          config: { numStartups: 7, oauthAccount: backup.oauthAccount },
        })
        deepStrictEqual(yield* box.stored, [refreshedMain, backup])
      })
  )

  it.effect('returns to the main account once its limit resets', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start.epochMilliseconds)
      const main = login('main')
      const backup = login('backup')
      const box = yield* Sandbox.make({ live: main, accounts: [main, backup] })
      box.usage.set('main', { fiveHour: 95, resetsAt: at({ hours: 2 }) })
      box.usage.set('backup', { fiveHour: 10 })
      const rotation = yield* Rotation.Rotation.make({
        threshold: 90,
        interval: '1 minute',
      }).pipe(Effect.provide(box.layer))
      const activeAfterTick = Effect.gen(function* () {
        yield* rotation.tick().pipe(Effect.provide(box.layer))
        return (yield* box.claudeCode).config['oauthAccount']
      })

      deepStrictEqual(yield* activeAfterTick, backup.oauthAccount)
      yield* TestClock.adjust('1 hour')
      deepStrictEqual(yield* activeAfterTick, backup.oauthAccount)
      yield* TestClock.adjust('61 minutes')
      deepStrictEqual(yield* activeAfterTick, main.oauthAccount)
    })
  )

  it.effect('prefers accounts in priority order', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start.epochMilliseconds)
      const main = login('main')
      const second = login('second')
      const third = login('third')
      const box = yield* Sandbox.make({
        live: third,
        accounts: [main, second, third],
      })
      box.usage.set('main', { fiveHour: 99 })
      box.usage.set('second', { fiveHour: 50 })
      box.usage.set('third', { fiveHour: 0 })

      yield* tick().pipe(Effect.provide(box.layer))

      deepStrictEqual(
        (yield* box.claudeCode).config['oauthAccount'],
        second.oauthAccount
      )
    })
  )

  it.effect(
    'stays put when every other account is near its limits or unknown',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start.epochMilliseconds)
        const main = login('main')
        const exhausted = login('exhausted')
        const unknown = login('unknown')
        const box = yield* Sandbox.make({
          live: main,
          accounts: [main, exhausted, unknown],
        })
        box.usage.set('main', { fiveHour: 95 })
        box.usage.set('exhausted', { fiveHour: 40, sevenDay: 90 })
        box.usage.set('unknown', 'unauthorized')

        yield* tick().pipe(Effect.provide(box.layer))

        deepStrictEqual(
          (yield* box.claudeCode).config['oauthAccount'],
          main.oauthAccount
        )
      })
  )

  it.effect.each([
    {
      name: 'uses weekly reserve when the active 5-hour limit is full',
      mainUsage: { fiveHour: 39, sevenDay: 90 },
      backupUsage: { fiveHour: 100 },
      expected: 'main',
    },
    {
      name: 'uses 5-hour reserve when the active weekly limit is full',
      mainUsage: { fiveHour: 90 },
      backupUsage: { fiveHour: 10, sevenDay: 100 },
      expected: 'main',
    },
    {
      name: 'uses the remaining capacity when both limits are near full',
      mainUsage: { fiveHour: 99, sevenDay: 99 },
      backupUsage: { fiveHour: 100 },
      expected: 'main',
    },
    {
      name: 'prefers the main account when all accounts are in reserve',
      mainUsage: { fiveHour: 39, sevenDay: 90 },
      backupUsage: { fiveHour: 95 },
      expected: 'main',
    },
    {
      name: 'never falls back to an account with a full 5-hour limit',
      mainUsage: { fiveHour: 100 },
      backupUsage: { fiveHour: 10, sevenDay: 100 },
      expected: 'backup',
    },
    {
      name: 'never falls back to an account with a full weekly limit',
      mainUsage: { fiveHour: 39, sevenDay: 100 },
      backupUsage: { fiveHour: 100 },
      expected: 'backup',
    },
    {
      name: 'never falls back to an account with unknown usage',
      mainUsage: 'unauthorized' as const,
      backupUsage: { fiveHour: 100 },
      expected: 'backup',
    },
    {
      name: 'keeps an active account below the threshold ahead of reserve',
      mainUsage: { fiveHour: 39, sevenDay: 90 },
      backupUsage: { fiveHour: 89 },
      expected: 'backup',
    },
    {
      name: 'keeps an active account with unknown usage ahead of reserve',
      mainUsage: { fiveHour: 39, sevenDay: 90 },
      backupUsage: 'unauthorized' as const,
      expected: 'backup',
    },
  ])('$name', ({ mainUsage, backupUsage, expected }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start.epochMilliseconds)
      const main = login('main')
      const backup = login('backup')
      const box = yield* Sandbox.make({
        live: backup,
        accounts: [main, backup],
      })
      box.usage.set('main', mainUsage)
      box.usage.set('backup', backupUsage)

      yield* tick().pipe(Effect.provide(box.layer))

      deepStrictEqual(
        (yield* box.claudeCode).config['oauthAccount'],
        login(expected).oauthAccount
      )
    })
  )

  it.effect('keeps using reserve until an account recovers', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start.epochMilliseconds)
      const main = login('main')
      const backup = login('backup')
      const box = yield* Sandbox.make({
        live: backup,
        accounts: [main, backup],
      })
      box.usage.set('main', { fiveHour: 39, sevenDay: 90 })
      box.usage.set('backup', { fiveHour: 100, resetsAt: at({ hours: 1 }) })
      const rotation = yield* Rotation.Rotation.make({
        threshold: 90,
        interval: '1 minute',
      }).pipe(Effect.provide(box.layer))
      const activeAfterTick = Effect.gen(function* () {
        yield* rotation.tick()
        return (yield* box.claudeCode).config['oauthAccount']
      })

      deepStrictEqual(yield* activeAfterTick, main.oauthAccount)
      yield* TestClock.adjust('1 minute')
      deepStrictEqual(yield* activeAfterTick, main.oauthAccount)
      yield* TestClock.adjust('59 minutes')
      deepStrictEqual(yield* activeAfterTick, backup.oauthAccount)
    })
  )

  it.effect('leaves a login it does not manage alone', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start.epochMilliseconds)
      const stranger = login('stranger')
      const backup = login('backup')
      const box = yield* Sandbox.make({ live: stranger, accounts: [backup] })
      box.usage.set('stranger', { fiveHour: 100 })
      box.usage.set('backup', { fiveHour: 0 })

      yield* tick().pipe(Effect.provide(box.layer))

      deepStrictEqual(
        (yield* box.claudeCode).config['oauthAccount'],
        stranger.oauthAccount
      )
    })
  )

  it.effect(
    "refreshes an inactive account's expired token but never the active one's",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start.epochMilliseconds)
        const main = login('main', { expiresAt: at({ hours: -1 }) })
        const backup = login('backup', { expiresAt: at({ hours: -1 }) })
        const box = yield* Sandbox.make({
          live: main,
          accounts: [main, backup],
        })
        box.usage.set('main', { fiveHour: 0 })
        box.usage.set('backup', { fiveHour: 0 })

        yield* tick().pipe(Effect.provide(box.layer))

        deepStrictEqual(box.refreshed, ['backup:refresh:0'])
        deepStrictEqual(yield* box.stored, [
          main,
          login('backup', { generation: 1 }),
        ])
      })
  )
})
