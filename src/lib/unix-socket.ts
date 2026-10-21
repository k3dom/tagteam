import * as Net from 'node:net'

import { Effect, FileSystem, Path, Schema } from 'effect'

export class SocketInUseError extends Schema.TaggedError<
  SocketInUseError,
  { readonly brand: unique symbol }
>()('SocketInUseError', { path: Schema.String }) {
  override get message(): string {
    return `Another process is already listening at ${this.path}. Stop it before starting another.`
  }
}

/**
 * Prepares `socket` for a server to listen at: creates its directory, readable
 * only by its owner, and removes a socket that a crashed server left behind.
 * Fails when a server still answers at it.
 */
export const claim = Effect.fn('UnixSocket.claim')(function* (socket: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs
    .makeDirectory(path.dirname(socket), { recursive: true, mode: 0o700 })
    .pipe(Effect.orDie)
  if (!(yield* fs.exists(socket).pipe(Effect.orDie))) {
    return
  }
  const answers = yield* Effect.callback<boolean>((resume) => {
    const connection = Net.connect({ path: socket })
    connection.once('connect', () => {
      connection.destroy()
      resume(Effect.succeed(true))
    })
    connection.once('error', () => resume(Effect.succeed(false)))
    return Effect.sync(() => connection.destroy())
  })
  if (answers) {
    return yield* new SocketInUseError({ path: socket })
  }
  yield* fs.remove(socket).pipe(Effect.orDie)
})
