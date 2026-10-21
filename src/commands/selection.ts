import { Array, Effect, Number, Option, pipe, Schema } from 'effect'
import { Argument } from 'effect/cli'

import * as Login from '#/domain/login.ts'

export class AccountNotFoundError extends Schema.TaggedError<
  AccountNotFoundError,
  { readonly brand: unique symbol }
>()('AccountNotFoundError', { account: Schema.String }) {
  override get message(): string {
    return `No account matches "${this.account}". Run \`tagteam list\` to see your accounts and their numbers.`
  }
}

/** An account named by its number in `tagteam list` or its email. */
export const account = Argument.String('account').pipe(
  Argument.withDescription(
    'The account number from `tagteam list`, or its email'
  )
)

/** The account a user named by its number in `tagteam list` or its email. */
export const select = (
  logins: ReadonlyArray<Login.Login>,
  name: string
): Effect.Effect<Login.Login, AccountNotFoundError> =>
  pipe(
    Number.parse(name),
    Option.flatMap((position) => Array.get(logins, position - 1)),
    Option.orElse(() =>
      Array.findFirst(logins, (login) => Login.email(login) === name)
    ),
    Effect.fromOption,
    Effect.mapError(() => new AccountNotFoundError({ account: name }))
  )
