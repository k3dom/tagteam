import { Console, Effect, Match, Option } from 'effect'
import { Argument, Command } from 'effect/cli'

import * as Client from '#/client.ts'
import * as Accounts from '#/commands/accounts.ts'

export const switchTo = Command.make(
  'switch',
  { account: Accounts.account },
  Effect.fn('commands.switch')(function* ({ account }) {
    const client = yield* Client.Client
    const { email, switched } = yield* client.rotation.switch({
      payload: { account },
    })
    yield* Console.log(
      `${switched ? `Switched Claude Code to ${email}.` : `Claude Code is already on ${email}.`} Automatic switching is off until you run \`tagteam mode auto\`.`
    )
  })
).pipe(
  Command.withShortDescription('Switch Claude Code to an account'),
  Command.withDescription(
    'Switch Claude Code to an account and turn automatic switching off, so that it stays there. Running sessions use the account from their next message.'
  )
)

export const mode = Command.make(
  'mode',
  {
    mode: Argument.Literals('mode', ['auto', 'manual']).pipe(
      Argument.withDescription(
        'auto switches by usage, manual stays on the current account. Without it, prints the current mode.'
      ),
      Argument.optional
    ),
  },
  Effect.fn('commands.mode')(function* ({ mode: chosen }) {
    const client = yield* Client.Client
    if (Option.isSome(chosen)) {
      yield* client.rotation.setMode({ payload: { mode: chosen.value } })
    }
    const current = Option.isSome(chosen)
      ? chosen.value
      : (yield* client.rotation.mode()).mode
    yield* Console.log(
      Match.value(current).pipe(
        Match.when(
          'auto',
          () =>
            'Automatic switching is on, so tagteam keeps Claude Code on the first account in priority order that is under its limits.'
        ),
        Match.when(
          'manual',
          () =>
            'Automatic switching is off, so Claude Code stays on its account until you run `tagteam switch` or `tagteam mode auto`.'
        ),
        Match.exhaustive
      )
    )
  })
).pipe(
  Command.withShortDescription('Turn automatic switching on or off'),
  Command.withDescription(
    'Turn automatic switching on with `auto` or off with `manual`, or print whether it is on'
  )
)
