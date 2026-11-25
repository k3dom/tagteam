import { NodeServices } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import * as Cli from '#test/cli.ts'
import * as Sandbox from '#test/sandbox.ts'

const { login, serve, start } = Sandbox

layer(NodeServices.layer)('the rotation commands', (it) => {
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
})
