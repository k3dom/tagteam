import { NodeHttpClient } from '@effect/platform-node'
import { Context, Effect, Layer, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { HttpApiClient } from 'effect/http-api'

import * as Api from '#/api/api.ts'

export class DaemonUnreachableError extends Schema.TaggedError<
  DaemonUnreachableError,
  { readonly brand: unique symbol }
>()('DaemonUnreachableError', { socket: Schema.String }) {
  override get message(): string {
    return `tagteam's daemon isn't running, since nothing answers at ${this.socket}. Start it with \`tagteam daemon\`, or with \`systemctl --user start tagteam\` where Home Manager runs it.`
  }
}

/** The daemon's API, reached through its Unix socket. */
export class Client extends Context.Service<Client>()('@tagteam/Client', {
  make: Effect.fnUntraced(function* (socket: string) {
    const agent = yield* NodeHttpClient.makeAgent({ socketPath: socket })
    const http = (yield* NodeHttpClient.makeNodeHttp.pipe(
      Effect.provideService(NodeHttpClient.HttpAgent, agent)
    )).pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl('http://tagteam')),
      HttpClient.transformResponse(
        Effect.catchReason('HttpClientError', 'TransportError', () =>
          Effect.fail(new DaemonUnreachableError({ socket }))
        )
      )
    )
    return yield* HttpApiClient.makeWith(Api.Api, { httpClient: http })
  }),
}) {}

export const layer = Layer.effect(
  Client,
  Effect.flatMap(Api.socket, (socket) => Client.make(socket))
)
