import { NodeServices } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { assertNone, deepStrictEqual } from '@effect/vitest/utils'
import { Effect } from 'effect'

import * as ClaudeCode from '#/lib/claude-code.ts'
import * as Sandbox from '#test/sandbox.ts'

const { login } = Sandbox

layer(NodeServices.layer)('ClaudeCode', (it) => {
  it.effect(
    'switches nothing once Claude Code is logged into another account',
    () =>
      Effect.gen(function* () {
        const main = login('main')
        const backup = login('backup')
        const stranger = login('stranger')
        const box = yield* Sandbox.make({
          live: main,
          accounts: [main, backup],
        })
        yield* box.logIn(stranger)
        const before = yield* box.claudeCode

        const replaced = yield* Effect.gen(function* () {
          const claude = yield* ClaudeCode.ClaudeCode
          return yield* claude.activate(backup, main)
        }).pipe(Effect.provide(box.layer))

        assertNone(replaced)
        deepStrictEqual(yield* box.claudeCode, before)
      })
  )
})
