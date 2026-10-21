import { describe, it } from '@effect/vitest'
import { strictEqual } from '@effect/vitest/utils'
import { Duration } from 'effect'

import * as Format from '#/lib/format.ts'

describe('Format', () => {
  it('rounds a duration to whole minutes, and up to one minute at least', () => {
    strictEqual(Format.roughly(Duration.seconds(7_120)), '1h 59m')
    strictEqual(Format.roughly(Duration.seconds(7_170)), '2h')
    strictEqual(Format.roughly(Duration.seconds(20)), '1m')
  })

  it('labels a name only when there are labels', () => {
    strictEqual(Format.labels(['main', 'active']), ' (main, active)')
    strictEqual(Format.labels([]), '')
  })
})
