import { Array, Duration, Number, pipe } from 'effect'

/** A percentage rounded to a whole number, such as `13%`. */
export const percent = (value: number): string => `${Number.round(value, 0)}%`

/** A duration in whole minutes, and at least one, such as `1h 59m`. */
export const roughly = (duration: Duration.Duration): string =>
  pipe(
    Duration.toMinutes(duration),
    Number.round(0),
    Number.max(1),
    Duration.minutes,
    Duration.format
  )

/** Labels to follow a name, such as ` (main, active)`, or nothing. */
export const labels = (all: ReadonlyArray<string>): string =>
  Array.match(all, {
    onEmpty: () => '',
    onNonEmpty: (some) => ` (${Array.join(some, ', ')})`,
  })
