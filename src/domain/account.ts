import { Schema } from 'effect'

import * as Usage from '#/domain/usage.ts'

/** A managed account as the API shows it, without its tokens. */
export const Account = Schema.Struct({
  email: Schema.String,
  active: Schema.Boolean.annotate({
    description: 'Whether Claude Code is logged into it',
  }),
  usage: Usage.Check,
})
export type Account = typeof Account.Type

/** An account named by its number in `tagteam list` or by its email. */
export const Selector = Schema.String.annotate({
  description: 'The account number from `tagteam list`, or its email',
})

export class NotLoggedInError extends Schema.TaggedError<
  NotLoggedInError,
  { readonly brand: unique symbol }
>()('NotLoggedInError', {}, { httpApiStatus: 409 }) {
  override get message(): string {
    return "Claude Code isn't logged in with a Claude account. Log in with /login in Claude Code, then run `tagteam add` again."
  }
}

export class NotFoundError extends Schema.TaggedError<
  NotFoundError,
  { readonly brand: unique symbol }
>()(
  'AccountNotFoundError',
  { account: Schema.String },
  { httpApiStatus: 404 }
) {
  override get message(): string {
    return `No account matches "${this.account}". Run \`tagteam list\` to see your accounts and their numbers.`
  }
}

export class ClaudeCodeConfigError extends Schema.TaggedError<
  ClaudeCodeConfigError,
  { readonly brand: unique symbol }
>()('ClaudeCodeConfigError', { path: Schema.String }, { httpApiStatus: 500 }) {
  override get message(): string {
    return `Couldn't read ${this.path} because it isn't valid JSON. Check the file, or log in to Claude Code again to rewrite it.`
  }
}
