import { Schema } from 'effect'

import * as Plan from '#/domain/plan.ts'
import * as Usage from '#/domain/usage.ts'

export const Account = Schema.Struct({
  email: Schema.String,
  active: Schema.Boolean.annotate({
    description: 'Whether Claude Code is logged into it',
  }),
  plan: Plan.Plan.annotate({
    description: 'Its plan, which sets how close to its limits it may run',
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
    return "Claude Code isn't logged in with a Claude account. Log in with /login in Claude Code, then try again."
  }
}

export class UnmanagedError extends Schema.TaggedError<
  UnmanagedError,
  { readonly brand: unique symbol }
>()('UnmanagedLoginError', { email: Schema.String }, { httpApiStatus: 409 }) {
  override get message(): string {
    return `Claude Code is logged into ${this.email}, which tagteam doesn't manage, so switching would lose its login. Run \`tagteam add\` to add it, then switch again.`
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

export class ClaudeCodeBusyError extends Schema.TaggedError<
  ClaudeCodeBusyError,
  { readonly brand: unique symbol }
>()('ClaudeCodeBusyError', { path: Schema.String }, { httpApiStatus: 503 }) {
  override get message(): string {
    return `Couldn't switch, since another process has held the lock ${this.path} for too long. Try again in a few seconds.`
  }
}
