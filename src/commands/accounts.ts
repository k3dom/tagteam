import {
  Array,
  Console,
  DateTime,
  Effect,
  Option,
  pipe,
  Schema,
  String,
} from 'effect'
import { Argument, Command, Flag } from 'effect/cli'

import * as Client from '#/client.ts'
import * as Plan from '#/domain/plan.ts'
import * as Usage from '#/domain/usage.ts'
import * as Format from '#/lib/format.ts'

const account = Argument.String('account').pipe(
  Argument.withDescription(
    'The account number from `tagteam list`, or its email'
  )
)

export const add = Command.make(
  'add',
  {
    main: Flag.Boolean('main').pipe(
      Flag.withDescription('Make it the main account'),
      Flag.withDefault(false)
    ),
  },
  Effect.fn('commands.add')(function* ({ main }) {
    const client = yield* Client.Client
    const { email, position, added } = yield* client.accounts.add({
      payload: { main },
    })
    yield* Console.log(
      `${added ? 'Added' : 'Updated'} ${email} as account ${position}${position === 1 ? ', the main account' : ''}.`
    )
  })
).pipe(
  Command.withShortDescription('Add the account Claude Code is logged into'),
  Command.withDescription(
    'Add the account Claude Code is logged into, or update its stored login. To add another account, log in to it with /login in Claude Code and run this again.'
  )
)

export const list = Command.make(
  'list',
  {
    json: Flag.Boolean('json').pipe(
      Flag.withDescription(
        'Print the accounts as JSON, for scripts and widgets'
      ),
      Flag.withDefault(false)
    ),
  },
  Effect.fn('commands.list')(function* ({ json }) {
    const client = yield* Client.Client
    const all = yield* client.accounts.list()
    if (json) {
      const ListJson = Schema.fromJsonString(
        Schema.Struct({
          accounts: Schema.Array(
            Schema.Struct({
              position: Schema.Int,
              email: Schema.String,
              main: Schema.Boolean,
              active: Schema.Boolean,
              plan: Plan.Plan,
              usage: Schema.NullOr(
                Schema.Struct({
                  fiveHour: Schema.NullOr(Usage.Window),
                  sevenDay: Schema.NullOr(Usage.Window),
                  checkedAt: Schema.DateTimeUtcFromString,
                }).pipe(
                  Schema.encodeKeys({
                    fiveHour: 'five_hour',
                    sevenDay: 'seven_day',
                    checkedAt: 'checked_at',
                  })
                )
              ),
              failure: Schema.NullOr(
                Schema.Struct({
                  message: Schema.String,
                  retryAt: Schema.DateTimeUtcFromString,
                }).pipe(Schema.encodeKeys({ retryAt: 'retry_at' }))
              ),
            })
          ),
        }),
        { space: 2 }
      )
      const accounts = Array.map(
        all,
        ({ email, active, plan, usage }, index) => ({
          position: index + 1,
          email,
          main: index === 0,
          active,
          plan,
          usage: pipe(
            usage.latest,
            Option.map(({ usage: known, checkedAt }) => ({
              ...known,
              checkedAt,
            })),
            Option.getOrNull
          ),
          failure: Option.getOrNull(usage.failure),
        })
      )
      return yield* Console.log(
        yield* Schema.encodeEffect(ListJson)({ accounts }).pipe(Effect.orDie)
      )
    }
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
      const resets = Option.match(Option.fromNullishOr(window.resetsAt), {
        onNone: () => '',
        onSome: (resetsAt) =>
          `  resets in ${Format.roughly(DateTime.distance(now, resetsAt))}`,
      })
      return [
        `     ${pipe(name, String.padEnd(7))} ${pipe(Format.percent(window.utilization), String.padStart(4))}${resets}`,
      ]
    }

    yield* Console.log(
      pipe(
        all,
        Array.map(({ email, active, plan, usage }, index) => {
          const labels = Format.labels([
            ...(index === 0 ? ['main'] : []),
            ...(active ? ['active'] : []),
            Plan.label(plan),
          ])
          const latest = Option.match(usage.latest, {
            onNone: () =>
              Option.isNone(usage.failure)
                ? [
                    '     usage unknown until Claude Code refreshes its token on the next request',
                  ]
                : [],
            onSome: ({ usage: known, checkedAt }) => [
              ...describe('5-hour', known.fiveHour),
              ...describe('weekly', known.sevenDay),
              `     checked ${Format.roughly(DateTime.distance(checkedAt, now))} ago`,
            ],
          })
          const failure = Option.match(usage.failure, {
            onNone: () => [],
            onSome: ({ message, retryAt }) => [
              `     ${message} Checking again in ${Format.roughly(DateTime.distance(now, retryAt))}.`,
            ],
          })
          return Array.join(
            [
              `${active ? '*' : ' '} ${index + 1}. ${email}${labels}`,
              ...latest,
              ...failure,
            ],
            '\n'
          )
        }),
        Array.join('\n')
      )
    )
  })
).pipe(
  Command.withDescription(
    'List the accounts in priority order with their usage, as the daemon last checked it'
  )
)

export const main = Command.make(
  'main',
  { account },
  Effect.fn('commands.main')(function* ({ account: selected }) {
    const client = yield* Client.Client
    const { email } = yield* client.accounts.main({
      payload: { account: selected },
    })
    yield* Console.log(`${email} is now the main account.`)
  })
).pipe(
  Command.withDescription(
    'Make an account the main one, which Claude Code returns to whenever it is under its limits'
  )
)

export const remove = Command.make(
  'remove',
  { account },
  Effect.fn('commands.remove')(function* ({ account: selected }) {
    const client = yield* Client.Client
    const { email } = yield* client.accounts.remove({
      params: { account: selected },
    })
    yield* Console.log(
      `Removed ${email}. Claude Code stays logged into whichever account it is using.`
    )
  })
).pipe(Command.withDescription('Stop managing an account'))
