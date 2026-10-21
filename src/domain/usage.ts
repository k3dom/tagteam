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
