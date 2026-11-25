import { createServer } from 'node:http'

import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'

import * as Api from '#/api/api.ts'
import * as AccountsHttp from '#/http/accounts.ts'
import * as RotationHttp from '#/http/rotation.ts'
import * as UnixSocket from '#/lib/unix-socket.ts'

export const layer = (socket: string) =>
  HttpRouter.serve(
    HttpApiBuilder.layer(Api.Api).pipe(
      Layer.provide(Layer.mergeAll(AccountsHttp.layer, RotationHttp.layer))
    ),
    { disableLogger: true }
  ).pipe(
    Layer.provide(
      Layer.unwrap(
        UnixSocket.claim(socket).pipe(
          Effect.as(
            NodeHttpServer.layer(createServer, {
              path: socket,
              gracefulShutdownTimeout: '1 second',
            })
          )
        )
      )
    )
  )
