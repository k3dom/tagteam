import { Schema } from 'effect'

/** How much of one rate limit an account has used, as Anthropic reports it. */
export const Window = Schema.Struct({
  utilization: Schema.Number,
  resetsAt: Schema.NullOr(Schema.DateTimeUtcFromString),
}).pipe(Schema.encodeKeys({ resetsAt: 'resets_at' }))
export type Window = typeof Window.Type

export const Usage = Schema.Struct({
  fiveHour: Schema.NullOr(Window),
  sevenDay: Schema.NullOr(Window),
}).pipe(Schema.encodeKeys({ fiveHour: 'five_hour', sevenDay: 'seven_day' }))
export type Usage = typeof Usage.Type

/**
 * What the daemon knows of an account's usage: the latest it fetched, and why
 * its latest check failed if it did. Both are empty for the account Claude
 * Code is using while its token has expired, since only Claude Code may
 * refresh that token.
 */
export const Check = Schema.Struct({
  latest: Schema.Option(
    Schema.Struct({ usage: Usage, checkedAt: Schema.DateTimeUtc })
  ),
  failure: Schema.Option(
    Schema.Struct({ message: Schema.String, retryAt: Schema.DateTimeUtc })
  ),
})
export type Check = typeof Check.Type
