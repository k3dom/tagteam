import { NodeServices } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { assertSome, deepStrictEqual } from '@effect/vitest/utils'
import { Effect, Option } from 'effect'
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
        // Another tagteam process switched Claude Code to the backup account
        // after this one read it as inactive.
        yield* box.logIn(backup)

        const usage = yield* Rotation.usageOf(backup, { active: false }).pipe(
          Effect.provide(box.layer)
        )

        deepStrictEqual(box.refreshed, [])
        assertSome(
          Option.map(usage, ({ fiveHour }) => fiveHour?.utilization),
          20
        )
      })
  )
})
