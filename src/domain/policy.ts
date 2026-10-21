import { Array, DateTime, Option, pipe } from 'effect'

import type * as Login from '#/domain/login.ts'
import type * as Usage from '#/domain/usage.ts'

export interface Limit {
  readonly name: '5-hour' | 'weekly'
  readonly window: Usage.Window
}

/** The first limit of which `usage` has reached `threshold` percent. */
export const exhausted = (
  usage: Usage.Usage,
  threshold: number,
  now: DateTime.Utc
): Option.Option<Limit> =>
  Array.findFirst(
    [
      { name: '5-hour' as const, window: usage.fiveHour },
      { name: 'weekly' as const, window: usage.sevenDay },
    ],
    (limit): limit is Limit =>
      limit.window !== null &&
      limit.window.utilization >= threshold &&
      (limit.window.resetsAt === null ||
        DateTime.isGreaterThan(limit.window.resetsAt, now))
  )

export interface Candidate {
  readonly login: Login.Login
  readonly active: boolean
  readonly usage: Option.Option<Usage.Usage>
}

/**
 * The account Claude Code should switch to: the first one in priority order
 * that is under its limits. An account whose usage is unknown only counts as
 * under its limits while it is active, so that tagteam never switches to an
 * account it couldn't check.
 */
export const choose = (
  candidates: ReadonlyArray<Candidate>,
  threshold: number,
  now: DateTime.Utc
): Option.Option<Candidate> =>
  pipe(
    Array.findFirst(candidates, ({ active, usage }) =>
      Option.match(usage, {
        onNone: () => active,
        onSome: (known) => Option.isNone(exhausted(known, threshold, now)),
      })
    ),
    Option.filter(({ active }) => !active)
  )
