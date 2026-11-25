import { NodeServices } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { assertSome, deepStrictEqual } from '@effect/vitest/utils'
import { Array, Effect, Exit, Layer } from 'effect'
import { TestClock } from 'effect/testing'

import * as Server from '#/app/server.ts'
import * as Client from '#/client.ts'
import * as Account from '#/domain/account.ts'
import * as Plan from '#/domain/plan.ts'
import * as Rotation from '#/services/rotation.ts'
import * as Cli from '#test/cli.ts'
import * as Sandbox from '#test/sandbox.ts'

const { login, start } = Sandbox

/** A sandbox whose daemon serves the API, without rotating on a schedule. */
const serve = Effect.fnUntraced(function* (
  options: Parameters<typeof Sandbox.make>[0]
) {
  const box = yield* Sandbox.make(options)
  yield* Layer.build(
    Server.layer(box.socket).pipe(
      Layer.provide(
        Rotation.layer({
          thresholds: Plan.defaultThresholds,
          interval: '1 minute',
        })
      ),
      Layer.provide(box.layer)
    )
  )
  return box
})

layer(NodeServices.layer)('the account commands', (it) => {
  it.effect('add the logged-in account and list it with its usage', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start.epochMilliseconds)
      const main = login('main')
      const backup = login('backup')
      const box = yield* serve({ live: main, accounts: [backup] })
      box.usage.set('main', { fiveHour: 42.4, sevenDay: 7 })
      box.usage.set('backup', 'rate-limited')

      const added = yield* Cli.run(box.socket, ['add', '--main'])
      const listed = yield* Cli.run(box.socket, ['list'])

      deepStrictEqual(added.stdout, [
        'Added main@example.com as account 1, the main account.',
      ])
      deepStrictEqual(listed.stdout, [
        [
          '* 1. main@example.com (main, active, Pro)',
          '     5-hour   42%  resets in 2h',
          '     weekly    7%  resets in 3d',
          '     checked 1m ago',
          '  2. backup@example.com (Pro)',
          "     Couldn't check usage because Anthropic limits how often it can be checked. Checking again in 2m.",
        ].join('\n'),
      ])
      deepStrictEqual(yield* box.stored, [main, backup])
    })
  )

  it.effect('list the accounts as JSON', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start.epochMilliseconds)
      const main = login('main')
      const backup = login('backup', {
        organizationTier: 'default_claude_max_20x',
      })
      const box = yield* serve({ live: backup, accounts: [main, backup] })
      box.usage.set('main', 'rate-limited')
      box.usage.set('backup', { fiveHour: 42.4, sevenDay: 7 })

      const listed = yield* Cli.run(box.socket, ['list', '--json'])

      deepStrictEqual(
        Array.map(listed.stdout, (line) => JSON.parse(globalThis.String(line))),
        [
          {
            mode: 'auto',
            accounts: [
              {
                position: 1,
                email: 'main@example.com',
                main: true,
                active: false,
                plan: 'pro',
                usage: null,
                failure: {
                  message:
                    "Couldn't check usage because Anthropic limits how often it can be checked.",
                  retry_at: '2026-10-21T08:02:00.000Z',
                },
              },
              {
                position: 2,
                email: 'backup@example.com',
                main: false,
                active: true,
                plan: 'max-20x',
                usage: {
                  five_hour: {
                    utilization: 42.4,
                    resets_at: '2026-10-21T10:00:00.000Z',
                  },
                  seven_day: {
                    utilization: 7,
                    resets_at: '2026-10-24T08:00:00.000Z',
                  },
                  checked_at: '2026-10-21T08:00:00.000Z',
                },
                failure: null,
              },
            ],
          },
        ]
      )
    })
  )

  it.effect(
    'switch to an account by hand until switching is automatic again',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start.epochMilliseconds)
        const main = login('main')
        const backup = login('backup')
        const box = yield* serve({ live: main, accounts: [main, backup] })
        box.usage.set('main', { fiveHour: 10 })
        box.usage.set('backup', { fiveHour: 20 })

        const switched = yield* Cli.run(box.socket, ['switch', '2'])
        const listed = yield* Cli.run(box.socket, ['list'])
        const manual = yield* Cli.run(box.socket, ['mode'])
        const auto = yield* Cli.run(box.socket, ['mode', 'auto'])

        deepStrictEqual(switched.stdout, [
          'Switched Claude Code to backup@example.com. Automatic switching is off until you run `tagteam mode auto`.',
        ])
        deepStrictEqual(listed.stdout, [
          [
            'Automatic switching is off. Switch with `tagteam switch`, or turn it on with `tagteam mode auto`.',
            '  1. main@example.com (main, Pro)',
            '     5-hour   10%  resets in 2h',
            '     weekly    0%  resets in 3d',
            '     checked 1m ago',
            '* 2. backup@example.com (active, Pro)',
            '     5-hour   20%  resets in 2h',
            '     weekly    0%  resets in 3d',
            '     checked 1m ago',
          ].join('\n'),
        ])
        deepStrictEqual(manual.stdout, [
          'Automatic switching is off, so Claude Code stays on its account until you run `tagteam switch` or `tagteam mode auto`.',
        ])
        deepStrictEqual(auto.stdout, [
          'Automatic switching is on, so tagteam keeps Claude Code on the first account in priority order that is under its limits.',
        ])
        deepStrictEqual(
          (yield* box.claudeCode).config['oauthAccount'],
          main.oauthAccount
        )
      })
  )

  it.effect("fails with the server's error for an unknown account", () =>
    Effect.gen(function* () {
      const main = login('main')
      const box = yield* serve({ live: main, accounts: [main] })

      const { exit } = yield* Cli.run(box.socket, ['remove', '2'])

      assertSome(
        Exit.findErrorOption(exit),
        new Account.NotFoundError({ account: '2' })
      )
      deepStrictEqual(yield* box.stored, [main])
    })
  )

  it.effect("says that the daemon isn't running when nothing answers", () =>
    Effect.gen(function* () {
      const main = login('main')
      const box = yield* Sandbox.make({ live: main, accounts: [main] })

      const { exit } = yield* Cli.run(box.socket, ['list'])

      assertSome(
        Exit.findErrorOption(exit),
        new Client.DaemonUnreachableError({ socket: box.socket })
      )
    })
  )
})
