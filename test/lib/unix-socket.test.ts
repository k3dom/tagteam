import * as Net from 'node:net'

import { NodeServices } from '@effect/platform-node'
import { assert, layer } from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'
import { Effect, FileSystem, Path } from 'effect'

import * as UnixSocket from '#/lib/unix-socket.ts'

const temporarySocket = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return path.join(yield* fs.makeTempDirectoryScoped(), 'run', 'test.sock')
})

const listen = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<Net.Server>((resume) => {
      const server = Net.createServer()
      server.listen(path, () => resume(Effect.succeed(server)))
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void))
      })
  )

layer(NodeServices.layer)('UnixSocket.claim', (it) => {
  it.effect('removes a socket that no server answers at anymore', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* temporarySocket
      yield* UnixSocket.claim(path)
      yield* fs.writeFileString(path, '')

      yield* UnixSocket.claim(path)

      assert.isFalse(yield* fs.exists(path))
    })
  )

  it.effect('refuses a socket that a server still answers at', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* temporarySocket
      yield* UnixSocket.claim(path)
      yield* listen(path)

      const error = yield* UnixSocket.claim(path).pipe(Effect.flip)

      deepStrictEqual(error, new UnixSocket.SocketInUseError({ path }))
      assert.isTrue(yield* fs.exists(path))
    })
  )
})
