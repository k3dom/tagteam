import { Duration, Effect } from 'effect'
import { Command, Flag } from 'effect/cli'

import * as Daemon from '#/app/daemon.ts'
import * as Plan from '#/domain/plan.ts'

const threshold = (plan: Plan.Plan) =>
  Flag.Int(`threshold-${plan}`).pipe(
    Flag.withDescription(
      `Switch away from a ${Plan.label(plan)} account once it has used this percentage of its 5-hour or weekly limit`
    ),
    Flag.filter(
      (percent) => percent >= 1 && percent <= 100,
      (percent) => `a percentage from 1 to 100, not ${percent}`
    ),
    Flag.withDefault(Plan.defaultThresholds[plan])
  )

export const command = Command.make(
  'daemon',
  {
    thresholds: {
      pro: threshold('pro'),
      'max-5x': threshold('max-5x'),
      'max-20x': threshold('max-20x'),
    },
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
  Effect.fn('commands.daemon')(function* ({ thresholds, interval }) {
    return yield* Daemon.run({
      thresholds,
      interval: Duration.seconds(interval),
    })
  })
).pipe(
  Command.withDescription(
    'Watch the usage of every account, switch Claude Code to the first one in priority order that is under its limits, and serve the other commands'
  )
)
