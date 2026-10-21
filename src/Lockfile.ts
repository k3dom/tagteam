import {
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Option,
  Ref,
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
export const acquire = Effect.fn('Lockfile.acquire')(function* (
  path: string,
  options: { readonly stale: Duration.Input; readonly timeout: Duration.Input }
) {
  const fs = yield* FileSystem.FileSystem
  const held = yield* Ref.make(false)
  yield* Effect.addFinalizer(
    Effect.fnUntraced(function* () {
      if (yield* Ref.get(held)) {
        yield* fs.remove(path, { recursive: true }).pipe(Effect.ignore)
      }
    })
  )

  const removeIfStale = Effect.gen(function* () {
    const info = yield* fs.stat(path)
    const touched = Option.match(info.mtime, {
      onNone: () => DateTime.makeUnsafe(0),
      onSome: DateTime.fromDateUnsafe,
    })
    const age = DateTime.distance(touched, yield* DateTime.now)
    if (Duration.isGreaterThan(age, Duration.fromInputUnsafe(options.stale))) {
      yield* fs.remove(path, { recursive: true })
    }
  }).pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.void))

  // Uninterruptible, so a lock it takes is always marked for release.
  const tryTake = Effect.gen(function* () {
    yield* fs.makeDirectory(path)
    yield* Ref.set(held, true)
    return true
  }).pipe(
    Effect.catchReason('PlatformError', 'AlreadyExists', () =>
      removeIfStale.pipe(Effect.as(false))
    ),
    Effect.uninterruptible
  )

  yield* tryTake.pipe(
    Effect.repeat({
      until: (taken: boolean) => taken,
      schedule: Schedule.spaced('250 millis').pipe(Schedule.jittered),
    }),
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () => Effect.fail(new LockTimeoutError({ path })),
    }),
    Effect.catchTag('PlatformError', Effect.die)
  )

  yield* Effect.gen(function* () {
    const now = DateTime.toDate(yield* DateTime.now)
    yield* fs.utimes(path, now, now)
  }).pipe(
    Effect.ignore,
    Effect.repeat(Schedule.spaced('3 seconds')),
    Effect.forkScoped
  )
})
