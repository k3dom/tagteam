import { NodeServices } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { assertSome, deepStrictEqual } from '@effect/vitest/utils'
import { Array, DateTime, Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'

import * as UsageCache from '#/services/usage-cache.ts'
import * as Sandbox from '#test/sandbox.ts'

const { at, login, start } = Sandbox

layer(NodeServices.layer)('UsageCache', (it) => {
  it.effect(
    'asks Anthropic again only once a check is due, the active account first',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start.epochMilliseconds)
        const main = login('main')
        const backup = login('backup')
        const box = yield* Sandbox.make({
          live: main,
          accounts: [main, backup],
        })
        box.usage.set('main', { fiveHour: 40 })
        box.usage.set('backup', { fiveHour: 10 })
        const cache = yield* UsageCache.UsageCache.pipe(
          Effect.provide(box.layer)
        )

        yield* cache.list()
        yield* cache.list()
        deepStrictEqual(box.checked, ['main', 'backup'])

        yield* TestClock.adjust('1 minute')
        yield* cache.list()
        deepStrictEqual(box.checked, ['main', 'backup', 'main'])

        yield* TestClock.adjust('4 minutes')
        box.usage.set('backup', { fiveHour: 30 })
        const accounts = yield* cache.list()
        deepStrictEqual(box.checked, [
          'main',
          'backup',
          'main',
          'main',
          'backup',
        ])
        deepStrictEqual(
          Array.map(accounts, ({ email, active, usage }) => ({
            email,
            active,
            fiveHour: Option.map(
              usage.latest,
              ({ usage: known }) => known.fiveHour?.utilization
            ),
          })),
          [
            {
              email: 'main@example.com',
              active: true,
              fiveHour: Option.some(40),
            },
            {
              email: 'backup@example.com',
              active: false,
              fiveHour: Option.some(30),
            },
          ]
        )
      })
  )

  it.effect(
    'keeps the last usage while Anthropic rate limits checks, and waits as long as it asks',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start.epochMilliseconds)
        const main = login('main')
        const box = yield* Sandbox.make({ live: main, accounts: [main] })
        box.usage.set('main', { fiveHour: 40 })
        const cache = yield* UsageCache.UsageCache.pipe(
          Effect.provide(box.layer)
        )
        yield* cache.list()

        yield* TestClock.adjust('1 minute')
        box.usage.set('main', 'rate-limited')
        const limited = Array.getUnsafe(yield* cache.list(), 0)
        yield* TestClock.adjust('1 minute')
        yield* cache.list()

        deepStrictEqual(box.checked, ['main', 'main'])
        deepStrictEqual(
          Option.map(limited.usage.latest, (latest) => ({
            fiveHour: latest.usage.fiveHour?.utilization,
            checkedAt: latest.checkedAt,
          })),
          Option.some({ fiveHour: 40, checkedAt: start })
        )
        deepStrictEqual(
          limited.usage.failure,
          Option.some({
            message:
              "Couldn't check usage because Anthropic limits how often it can be checked.",
            retryAt: DateTime.add(start, { minutes: 3 }),
          })
        )

        yield* TestClock.adjust('1 minute')
        box.usage.set('main', { fiveHour: 50 })
        const recovered = Array.getUnsafe(yield* cache.list(), 0)
        deepStrictEqual(box.checked, ['main', 'main', 'main'])
        deepStrictEqual(recovered.usage.failure, Option.none())
      })
  )

  it.effect(
    'leaves the refresh to Claude Code once it switched to the account',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start.epochMilliseconds)
        const main = login('main')
        const backup = login('backup', { expiresAt: at({ minutes: 1 }) })
        const box = yield* Sandbox.make({
          live: main,
          accounts: [main, backup],
        })
        box.usage.set('backup', { fiveHour: 20 })
        // The rotation switched Claude Code to the backup account after the
        // caller read it as inactive.
        yield* box.logIn(backup)

        const check = yield* Effect.gen(function* () {
          const cache = yield* UsageCache.UsageCache
          return yield* cache.get(backup, { active: false })
        }).pipe(Effect.provide(box.layer))

        deepStrictEqual(box.refreshed, [])
        assertSome(
          Option.map(check.latest, ({ usage }) => usage.fiveHour?.utilization),
          20
        )
      })
  )
})
