import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'

import * as Api from '#/api/api.ts'
import * as Accounts from '#/services/accounts.ts'
import * as Rotation from '#/services/rotation.ts'

export const layer = HttpApiBuilder.group(
  Api.Api,
  'rotation',
  Effect.fnUntraced(function* (handlers) {
    const accounts = yield* Accounts.Accounts
    const rotation = yield* Rotation.Rotation
    return handlers.handleAll({
      mode: () => accounts.mode().pipe(Effect.map((mode) => ({ mode }))),
      setMode: ({ payload }) => rotation.setMode(payload.mode),
      switch: ({ payload }) => rotation.switchTo(payload.account),
    })
  })
)
