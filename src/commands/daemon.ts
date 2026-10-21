import { Duration, Effect } from 'effect'
import { Command, Flag } from 'effect/cli'

import * as Daemon from '#/app/daemon.ts'

export const command = Command.make(
  'daemon',
  {
    threshold: Flag.Int('threshold').pipe(
      Flag.withDescription(
        'Switch away from an account once it has used this percentage of its 5-hour or weekly limit'
      ),
      Flag.filter(
        (threshold) => threshold >= 1 && threshold <= 100,
        (threshold) => `a percentage from 1 to 100, not ${threshold}`
      ),
      Flag.withDefault(90)
    ),
    interval: Flag.Int('interval').pipe(
      Flag.withDescription('Seconds between usage checks'),
      Flag.filter(
        (interval) => interval >= 10,
        (interval) =>
          `at least 10 seconds, since Anthropic rate limits usage requests, not ${interval}`
      ),
      Flag.withDefault(60)
    ),
  },
  Effect.fn('commands.daemon')(function* ({ threshold, interval }) {
    return yield* Daemon.run({
      threshold,
      interval: Duration.seconds(interval),
    })
  })
).pipe(
  Command.withDescription(
    'Watch the usage of every account, switch Claude Code to the first one in priority order that is under its limits, and serve the other commands'
  )
)
