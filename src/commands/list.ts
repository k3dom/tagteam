import {
  Array,
  Console,
  DateTime,
  Effect,
  Option,
  pipe,
  Result,
  String,
} from 'effect'
import { Command } from 'effect/cli'

import * as Login from '#/domain/login.ts'
import type * as Usage from '#/domain/usage.ts'
import * as Format from '#/lib/format.ts'
import * as Accounts from '#/services/accounts.ts'
import * as ClaudeCode from '#/services/claude-code.ts'
import * as Rotation from '#/services/rotation.ts'
import * as UsageCache from '#/services/usage-cache.ts'

export const command = Command.make(
  'list',
  {},
  Effect.fn('commands.list')(function* () {
    const claude = yield* ClaudeCode.ClaudeCode
    const accounts = yield* Accounts.Accounts
    const cache = yield* UsageCache.UsageCache
    const live = yield* claude.current()
    const all = yield* accounts.list()
    if (Array.isReadonlyArrayEmpty(all)) {
      return yield* Console.log(
        'No accounts yet. Run `tagteam add` to add the account Claude Code is logged into.'
      )
    }
    const now = yield* DateTime.now
    const describe = (
      name: string,
      window: Usage.Window | null
    ): ReadonlyArray<string> => {
      if (window === null) {
        return []
      }
      const label = pipe(name, String.padEnd(7))
      const used = `${label} ${pipe(Format.percent(window.utilization), String.padStart(4))}`
      return [
        Option.match(Option.fromNullishOr(window.resetsAt), {
          onNone: () => `     ${used}`,
          onSome: (resetsAt) =>
            DateTime.isGreaterThan(resetsAt, now)
              ? `     ${used}  resets in ${Format.roughly(DateTime.distance(now, resetsAt))}`
              : `     ${label} reset ${Format.roughly(DateTime.distance(resetsAt, now))} ago`,
        }),
      ]
    }
    const windows = (usage: Usage.Usage) => [
      ...describe('5-hour', usage.fiveHour),
      ...describe('weekly', usage.sevenDay),
    ]

    yield* Effect.forEach(
      all,
      Effect.fnUntraced(function* (stored, index) {
        const current = Option.filter(live, (login) =>
          Login.sameAccount(login, stored)
        )
        const active = Option.isSome(current)
        const usage = yield* Rotation.usageOf(
          Option.getOrElse(current, () => stored),
          { active }
        ).pipe(Effect.result)
        const labels = Format.labels(
          Array.appendAll(index === 0 ? ['main'] : [], active ? ['active'] : [])
        )
        const lastSeen = Effect.fnUntraced(function* (
          why: string,
          otherwise: string
        ) {
          return Option.match(yield* cache.get(stored), {
            onNone: () => [`     ${otherwise}`],
            onSome: (seen) => [
              ...windows(seen.usage),
              `     last checked ${Format.roughly(DateTime.distance(seen.checkedAt, now))} ago. ${why}`,
            ],
          })
        })
        const details = yield* Result.match(usage, {
          onFailure: (error) =>
            lastSeen(error.message, `usage unavailable: ${error.message}`),
          onSuccess: Option.match({
            onNone: () =>
              lastSeen(
                'Claude Code refreshes its token on its next request, and then usage can be checked again.',
                'usage unknown until Claude Code refreshes its token on the next request'
              ),
            onSome: (known) => Effect.succeed(windows(known)),
          }),
        })
        yield* Console.log(
          Array.join(
            [
              `${active ? '*' : ' '} ${index + 1}. ${Login.email(stored)}${labels}`,
              ...details,
            ],
            '\n'
          )
        )
      })
    )
  })
).pipe(
  Command.withDescription(
    'List the accounts in priority order with their current usage'
  )
)
