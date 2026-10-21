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
 * Prepares `path` for a server to listen at: creates its directory, readable
 * only by its owner, and removes a socket that a crashed server left behind.
 * Fails when a server still answers at `path`.
 */
export const claim = Effect.fn('UnixSocket.claim')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const { dirname } = yield* Path.Path
  yield* fs
    .makeDirectory(dirname(path), { recursive: true, mode: 0o700 })
    .pipe(Effect.orDie)
  if (!(yield* fs.exists(path).pipe(Effect.orDie))) {
    return
  }
  const answers = yield* Effect.callback<boolean>((resume) => {
    const socket = Net.connect({ path })
    socket.once('connect', () => {
      socket.destroy()
      resume(Effect.succeed(true))
    })
    socket.once('error', () => resume(Effect.succeed(false)))
    return Effect.sync(() => socket.destroy())
  })
  if (answers) {
    return yield* new SocketInUseError({ path })
  }
  yield* fs.remove(path).pipe(Effect.orDie)
})
