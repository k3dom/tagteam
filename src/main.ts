import { NodeRuntime, NodeServices } from '@effect/platform-node'
import {
  Array,
  Console,
  DateTime,
  Duration,
  Effect,
  Layer,
  Number,
  Option,
  pipe,
  Schema,
} from 'effect'
import { Argument, Command, Flag } from 'effect/cli'

import * as Accounts from '#/Accounts.ts'
import * as Anthropic from '#/Anthropic.ts'
import * as ClaudeCode from '#/ClaudeCode.ts'
import * as Rotation from '#/Rotation.ts'
import PackageJson from '#package.json' with { type: 'json' }

class NotLoggedInError extends Schema.TaggedError<
  NotLoggedInError,
  { readonly brand: unique symbol }
>()('NotLoggedInError', {}) {
  override get message(): string {
    return "Claude Code isn't logged in with a Claude account. Log in with /login in Claude Code, then run `tagteam add` again."
  }
}

class AccountNotFoundError extends Schema.TaggedError<
  AccountNotFoundError,
  { readonly brand: unique symbol }
>()('AccountNotFoundError', { account: Schema.String }) {
  override get message(): string {
    return `No account matches "${this.account}". Run \`tagteam list\` to see your accounts and their numbers.`
  }
}

const selector = Argument.String('account').pipe(
  Argument.withDescription(
    'The account number from `tagteam list`, or its email'
  )
)

const find = (
  accounts: ReadonlyArray<ClaudeCode.Login>,
  account: string
): Effect.Effect<ClaudeCode.Login, AccountNotFoundError> =>
  pipe(
    Number.parse(account),
    Option.flatMap((position) => Array.get(accounts, position - 1)),
    Option.orElse(() =>
      Array.findFirst(accounts, (login) => ClaudeCode.email(login) === account)
    ),
    Effect.fromOption,
    Effect.mapError(() => new AccountNotFoundError({ account }))
  )

const without = (
  accounts: ReadonlyArray<ClaudeCode.Login>,
  login: ClaudeCode.Login
) =>
  Array.filter(
    accounts,
    (other) => ClaudeCode.id(other) !== ClaudeCode.id(login)
  )

const add = Command.make(
  'add',
  {
    main: Flag.Boolean('main').pipe(
      Flag.withDescription('Make it the main account'),
      Flag.withDefault(false)
    ),
  },
  Effect.fnUntraced(function* ({ main }) {
    const claude = yield* ClaudeCode.ClaudeCode
    const accounts = yield* Accounts.Accounts
    const live = yield* claude.current()
    if (Option.isNone(live)) {
      return yield* new NotLoggedInError()
    }
    const login = live.value
    const position = yield* accounts.modify((all) => {
      const known = Array.some(
        all,
        (other) => ClaudeCode.id(other) === ClaudeCode.id(login)
      )
      const next = main
        ? Array.prepend(without(all, login), login)
        : known
          ? Array.map(all, (other) =>
              ClaudeCode.id(other) === ClaudeCode.id(login) ? login : other
            )
          : Array.append(all, login)
      return Effect.succeed([
        {
          known,
          index: Array.findFirstIndex(
            next,
            (other) => ClaudeCode.id(other) === ClaudeCode.id(login)
          ),
        },
        next,
      ] as const)
    })
    yield* Console.log(
      `${position.known ? 'Updated' : 'Added'} ${ClaudeCode.email(login)} as account ${Option.getOrElse(position.index, () => 0) + 1}${Option.contains(position.index, 0) ? ', the main account' : ''}.`
    )
  })
).pipe(
  Command.withDescription(
    'Add the account Claude Code is logged into, or update its stored login. To add another account, log in to it with /login in Claude Code and run this again.'
  )
)

const remove = Command.make(
  'remove',
  { account: selector },
  Effect.fnUntraced(function* ({ account }) {
    const accounts = yield* Accounts.Accounts
    const removed = yield* accounts.modify(
      Effect.fnUntraced(function* (all) {
        const login = yield* find(all, account)
        return [login, without(all, login)] as const
      })
    )
    yield* Console.log(
      `Removed ${ClaudeCode.email(removed)}. Claude Code stays logged into whichever account it is using.`
    )
  })
).pipe(Command.withDescription('Stop managing an account'))

const main = Command.make(
  'main',
  { account: selector },
  Effect.fnUntraced(function* ({ account }) {
    const accounts = yield* Accounts.Accounts
    const login = yield* accounts.modify(
      Effect.fnUntraced(function* (all) {
        const chosen = yield* find(all, account)
        return [chosen, Array.prepend(without(all, chosen), chosen)] as const
      })
    )
    yield* Console.log(`${ClaudeCode.email(login)} is now the main account.`)
  })
).pipe(
  Command.withDescription(
    'Make an account the main one, which Claude Code returns to whenever it is under its limits'
  )
)

const list = Command.make(
  'list',
  {},
  Effect.fnUntraced(function* () {
    const claude = yield* ClaudeCode.ClaudeCode
    const accounts = yield* Accounts.Accounts
    const live = yield* claude.current()
    const all = yield* accounts.list()
    if (Array.isReadonlyArrayEmpty(all)) {
      return yield* Console.log(
        'No accounts yet. Run `tagteam add` to add the account Claude Code is logged into.'
      )
    }
    const now = yield* DateTime.now
    const describe = (name: string, window: Anthropic.Window | null) =>
      window === null
        ? []
        : [
            `     ${name.padEnd(7)} ${`${Math.round(window.utilization)}%`.padStart(4)}${
              window.resetsAt === null
                ? ''
                : `  resets in ${Duration.format(
                    Duration.minutes(
                      Math.max(
                        1,
                        Math.floor(
                          Duration.toMinutes(
                            DateTime.distance(now, window.resetsAt)
                          )
                        )
                      )
                    )
                  )}`
            }`,
          ]

    yield* Effect.forEach(all, (stored, index) =>
      Effect.gen(function* () {
        const active = Option.exists(
          live,
          (login) => ClaudeCode.id(login) === ClaudeCode.id(stored)
        )
        const usage = yield* Rotation.usageOf(
          active ? Option.getOrElse(live, () => stored) : stored,
          { active }
        ).pipe(Effect.result)
        const tags = [
          ...(index === 0 ? ['main'] : []),
          ...(active ? ['active'] : []),
        ]
        yield* Console.log(
          [
            `${active ? '*' : ' '} ${index + 1}. ${ClaudeCode.email(stored)}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`,
            ...(usage._tag === 'Failure'
              ? [`     usage unavailable: ${usage.failure.message}`]
              : Option.match(usage.success, {
                  onNone: () => [
                    '     usage unknown until Claude Code refreshes its token on the next request',
                  ],
                  onSome: (current) => [
                    ...describe('5-hour', current.fiveHour),
                    ...describe('weekly', current.sevenDay),
                  ],
                })),
          ].join('\n')
        )
      })
    )
  })
).pipe(
  Command.withDescription(
    'List the accounts in priority order with their current usage'
  )
)

const daemon = Command.make(
  'daemon',
  {
    threshold: Flag.Int('threshold').pipe(
      Flag.withDescription(
        'Switch away from an account once it has used this percentage of its 5-hour or weekly limit'
      ),
      Flag.filter(
        (threshold) => threshold >= 1 && threshold <= 100,
        (threshold) => `a percentage from 1 to 100, not ${threshold}`
      ),
      Flag.withDefault(90)
    ),
    interval: Flag.Int('interval').pipe(
      Flag.withDescription('Seconds between usage checks'),
      Flag.filter(
        (interval) => interval >= 10,
        (interval) =>
          `at least 10 seconds, since Anthropic rate limits usage requests, not ${interval}`
      ),
      Flag.withDefault(60)
    ),
  },
  ({ threshold, interval }) =>
    Rotation.run({ threshold, interval: Duration.seconds(interval) })
).pipe(
  Command.withDescription(
    'Watch the usage of every account and switch Claude Code to the first one in priority order that is under its limits'
  )
)

const report = (error: Error) =>
  Console.error(error.message).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1
      })
    )
  )

Command.make('tagteam').pipe(
  Command.withDescription(PackageJson.description),
  Command.withSubcommands([add, remove, main, list, daemon]),
  Command.run({ version: PackageJson.version }),
  Effect.catchTags({
    NotLoggedInError: report,
    AccountNotFoundError: report,
    ClaudeCodeError: report,
    LockTimeoutError: report,
  }),
  Effect.provide(
    Layer.mergeAll(ClaudeCode.layer, Accounts.layer, Anthropic.layer).pipe(
      Layer.provideMerge(NodeServices.layer)
    )
  ),
  NodeRuntime.runMain
)
