import { NodeServices } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { assertSome, deepStrictEqual } from '@effect/vitest/utils'
import { Effect, Exit, Layer } from 'effect'
import { TestClock } from 'effect/testing'

import * as Server from '#/app/server.ts'
import * as Client from '#/client.ts'
import * as Account from '#/domain/account.ts'
import * as Cli from '#test/cli.ts'
import * as Sandbox from '#test/sandbox.ts'

const { login, start } = Sandbox

/** A sandbox whose daemon serves the API, without rotating. */
const serve = Effect.fnUntraced(function* (
  options: Parameters<typeof Sandbox.make>[0]
) {
  const box = yield* Sandbox.make(options)
  yield* Layer.build(Server.layer(box.socket).pipe(Layer.provide(box.layer)))
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
          '* 1. main@example.com (main, active)',
          '     5-hour   42%  resets in 2h',
          '     weekly    7%  resets in 3d',
          '     checked 1m ago',
          '  2. backup@example.com',
          "     Couldn't check usage because Anthropic limits how often it can be checked. Checking again in 2m.",
        ].join('\n'),
      ])
      deepStrictEqual(yield* box.stored, [main, backup])
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
