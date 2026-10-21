import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'

import * as Api from '#/api/api.ts'
import * as Accounts from '#/services/accounts.ts'
import * as UsageCache from '#/services/usage-cache.ts'

export const layer = HttpApiBuilder.group(
  Api.Api,
  'accounts',
  Effect.fnUntraced(function* (handlers) {
    const accounts = yield* Accounts.Accounts
    const usageCache = yield* UsageCache.UsageCache
    return handlers.handleAll({
      list: () => usageCache.list(),
      add: ({ payload }) => accounts.add(payload),
      remove: ({ params }) => accounts.remove(params.account),
      main: ({ payload }) => accounts.makeMain(payload.account),
    })
  })
)
