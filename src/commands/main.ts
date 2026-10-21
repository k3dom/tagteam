import { Array, Console, Effect } from 'effect'
import { Command } from 'effect/cli'

import * as Selection from '#/commands/selection.ts'
import * as Login from '#/domain/login.ts'
import * as Accounts from '#/services/accounts.ts'

export const command = Command.make(
  'main',
  { account: Selection.account },
  Effect.fn('commands.main')(function* ({ account }) {
    const accounts = yield* Accounts.Accounts
    const login = yield* accounts.modify(
      Effect.fnUntraced(function* (all) {
        const chosen = yield* Selection.select(all, account)
        return [
          chosen,
          Array.prepend(Login.remove(all, chosen), chosen),
        ] as const
      })
    )
    yield* Console.log(`${Login.email(login)} is now the main account.`)
  })
).pipe(
  Command.withDescription(
    'Make an account the main one, which Claude Code returns to whenever it is under its limits'
  )
)
