import { Console, Effect } from 'effect'
import { Command } from 'effect/cli'

import * as Selection from '#/commands/selection.ts'
import * as Login from '#/domain/login.ts'
import * as Accounts from '#/services/accounts.ts'

export const command = Command.make(
  'remove',
  { account: Selection.account },
  Effect.fn('commands.remove')(function* ({ account }) {
    const accounts = yield* Accounts.Accounts
    const removed = yield* accounts.modify(
      Effect.fnUntraced(function* (all) {
        const login = yield* Selection.select(all, account)
        return [login, Login.remove(all, login)] as const
      })
    )
    yield* Console.log(
      `Removed ${Login.email(removed)}. Claude Code stays logged into whichever account it is using.`
    )
  })
).pipe(Command.withDescription('Stop managing an account'))
