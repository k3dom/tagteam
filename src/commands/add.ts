import { Array, Console, Effect, Match, Option, Schema } from 'effect'
import { Command, Flag } from 'effect/cli'

import * as Login from '#/domain/login.ts'
import * as Accounts from '#/services/accounts.ts'
import * as ClaudeCode from '#/services/claude-code.ts'

class NotLoggedInError extends Schema.TaggedError<
  NotLoggedInError,
  { readonly brand: unique symbol }
>()('NotLoggedInError', {}) {
  override get message(): string {
    return "Claude Code isn't logged in with a Claude account. Log in with /login in Claude Code, then run `tagteam add` again."
  }
}

export const command = Command.make(
  'add',
  {
    main: Flag.Boolean('main').pipe(
      Flag.withDescription('Make it the main account'),
      Flag.withDefault(false)
    ),
  },
  Effect.fn('commands.add')(function* ({ main }) {
    const claude = yield* ClaudeCode.ClaudeCode
    const accounts = yield* Accounts.Accounts
    const live = yield* claude.current()
    if (Option.isNone(live)) {
      return yield* new NotLoggedInError()
    }
    const login = live.value
    const { known, position } = yield* accounts.modify((all) => {
      const isKnown = Option.isSome(Login.find(all, login))
      const next = Match.value({ main, known: isKnown }).pipe(
        Match.when({ main: true }, () =>
          Array.prepend(Login.remove(all, login), login)
        ),
        Match.when({ known: true }, () => Login.replace(all, login)),
        Match.orElse(() => Array.append(all, login))
      )
      const index = Array.findFirstIndex(next, (other) =>
        Login.sameAccount(other, login)
      )
      return Effect.succeed([
        { known: isKnown, position: index },
        next,
      ] as const)
    })
    yield* Console.log(
      `${known ? 'Updated' : 'Added'} ${Login.email(login)} as account ${Option.getOrElse(position, () => 0) + 1}${Option.contains(position, 0) ? ', the main account' : ''}.`
    )
  })
).pipe(
  Command.withShortDescription('Add the account Claude Code is logged into'),
  Command.withDescription(
    'Add the account Claude Code is logged into, or update its stored login. To add another account, log in to it with /login in Claude Code and run this again.'
  )
)
