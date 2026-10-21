import { NodeServices } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'
import { Effect, FileSystem, Layer, Logger } from 'effect'
import { Command } from 'effect/cli'
import { TestClock, TestConsole } from 'effect/testing'

import * as List from '#/commands/list.ts'
import * as Rotation from '#/services/rotation.ts'
import * as Sandbox from '#test/sandbox.ts'

const { at, login, start } = Sandbox

const list = Effect.gen(function* () {
  yield* Command.runWith(List.command, { version: 'test' })([])
  return yield* TestConsole.logLines
}).pipe(
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(Layer.fresh(TestConsole.layer))
)

layer(NodeServices.layer)('list', (it) => {
  it.effect(
    'shows the usage last seen while Anthropic rate limits the check',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start.epochMilliseconds)
        const main = login('main')
        const box = yield* Sandbox.make({ live: main, accounts: [main] })
        box.usage.set('main', { fiveHour: 42, sevenDay: 10 })
        yield* Rotation.usageOf(main, { active: true }).pipe(
          Effect.provide(box.layer)
        )
        yield* TestClock.adjust('3 minutes')
        box.usage.set('main', 'rate-limited')

        deepStrictEqual(yield* list.pipe(Effect.provide(box.layer)), [
          [
            '* 1. main@example.com (main, active)',
            '     5-hour   42%  resets in 1h 57m',
            '     weekly   10%  resets in 2d 23h 57m',
            "     Checked 3m ago. Couldn't check usage because Anthropic limits how often it can be checked.",
          ].join('\n'),
        ])
      })
  )

  it.effect(
    "shows the usage last seen until Claude Code refreshes the active account's token",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start.epochMilliseconds)
        const main = login('main', { expiresAt: at({ hours: 1 }) })
        const box = yield* Sandbox.make({ live: main, accounts: [main] })
        box.usage.set('main', { fiveHour: 42, sevenDay: 10 })
        yield* Rotation.usageOf(main, { active: true }).pipe(
          Effect.provide(box.layer)
        )
        yield* TestClock.adjust('3 hours')

        deepStrictEqual(yield* list.pipe(Effect.provide(box.layer)), [
          [
            '* 1. main@example.com (main, active)',
            '     5-hour  reset 1h ago',
            '     weekly   10%  resets in 2d 21h',
            '     Checked 3h ago. Usage can be checked again once Claude Code refreshes its token on its next request.',
          ].join('\n'),
        ])
      })
  )

  it.effect('says why usage is unavailable when none was seen before', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start.epochMilliseconds)
      const main = login('main')
      const box = yield* Sandbox.make({ live: main, accounts: [main] })
      box.usage.set('main', 'rate-limited')

      deepStrictEqual(yield* list.pipe(Effect.provide(box.layer)), [
        [
          '* 1. main@example.com (main, active)',
          "     Couldn't check usage because Anthropic limits how often it can be checked.",
        ].join('\n'),
      ])
    })
  )

  it.effect("still shows the usage when the cache can't be saved", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start.epochMilliseconds)
      const fs = yield* FileSystem.FileSystem
      const main = login('main')
      const box = yield* Sandbox.make({ live: main, accounts: [main] })
      box.usage.set('main', { fiveHour: 42, sevenDay: 10 })
      yield* fs.writeFileString(box.cache, 'not a directory')

      deepStrictEqual(yield* list.pipe(Effect.provide(box.layer)), [
        [
          '* 1. main@example.com (main, active)',
          '     5-hour   42%  resets in 2h',
          '     weekly   10%  resets in 3d',
        ].join('\n'),
      ])
    })
  )
})
