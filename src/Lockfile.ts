import {
  Clock,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Option,
  Random,
  Schedule,
  Schema,
} from 'effect'

export class LockTimeoutError extends Schema.TaggedError<
  LockTimeoutError,
  { readonly brand: unique symbol }
>()('LockTimeoutError', { path: Schema.String }) {
  override get message(): string {
    return `Timed out waiting for the lock ${this.path}, which another process is holding. Try again in a few seconds.`
  }
}

/**
 * Takes a lock compatible with the npm `proper-lockfile` package that Claude
 * Code uses: the lock is a directory, `mkdir` is the mutex, and a holder
 * touches its mtime so others only treat it as stale once the holder is gone.
 * The lock is released when the scope closes.
 */
export const acquire = Effect.fnUntraced(function* (
  path: string,
  options: { readonly stale: Duration.Input; readonly timeout: Duration.Input }
) {
  const fs = yield* FileSystem.FileSystem
  const stale = Duration.toMillis(options.stale)
  const deadline =
    (yield* Clock.currentTimeMillis) + Duration.toMillis(options.timeout)

  const removeIfStale = Effect.gen(function* () {
    const info = yield* fs.stat(path)
    const now = yield* Clock.currentTimeMillis
    const stamped = Option.match(info.mtime, {
      onNone: () => 0,
      onSome: (mtime) => mtime.getTime(),
    })
    if (now - stamped > stale) {
      yield* fs.remove(path, { recursive: true })
    }
  }).pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.void))

  const tryTake = fs.makeDirectory(path).pipe(
    Effect.as(true),
    Effect.catchReason('PlatformError', 'AlreadyExists', () =>
      Effect.as(removeIfStale, false)
    )
  )

  yield* Effect.acquireRelease(
    Effect.gen(function* () {
      while (!(yield* tryTake)) {
        if ((yield* Clock.currentTimeMillis) > deadline) {
          return yield* new LockTimeoutError({ path })
        }
        yield* Effect.sleep(
          Duration.millis(yield* Random.nextBetween(250, 500))
        )
      }
    }),
    () => fs.remove(path, { recursive: true }).pipe(Effect.ignore)
  ).pipe(Effect.catchTag('PlatformError', Effect.die))

  yield* Effect.gen(function* () {
    const now = DateTime.toDate(yield* DateTime.now)
    yield* fs.utimes(path, now, now)
  }).pipe(
    Effect.ignore,
    Effect.repeat(Schedule.spaced('3 seconds')),
    Effect.forkScoped
  )
})
