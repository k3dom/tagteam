import { NodeServices } from '@effect/platform-node'
import { assert, layer } from '@effect/vitest'
import { assertFailure } from '@effect/vitest/utils'
import { DateTime, Effect, Fiber, FileSystem, Path } from 'effect'

import * as Lockfile from '#/Lockfile.ts'

const lockPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return path.join(yield* fs.makeTempDirectoryScoped(), 'thing.lock')
})

layer(NodeServices.layer, { excludeTestServices: true })('Lockfile', (it) => {
  it.effect('holds the lock until the scope closes', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const lock = yield* lockPath
      yield* Effect.gen(function* () {
        yield* Lockfile.acquire(lock, {
          stale: '10 seconds',
          timeout: '1 second',
        })
        assert.isTrue(yield* fs.exists(lock))
      }).pipe(Effect.scoped)
      assert.isFalse(yield* fs.exists(lock))
    })
  )

  it.effect('waits for another holder to release the lock', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const lock = yield* lockPath
      yield* fs.makeDirectory(lock)
      const waiter = yield* Lockfile.acquire(lock, {
        stale: '10 seconds',
        timeout: '5 seconds',
      }).pipe(Effect.scoped, Effect.as('acquired'), Effect.forkChild)

      yield* Effect.sleep('700 millis')
      assert.isUndefined(waiter.pollUnsafe())
      yield* fs.remove(lock, { recursive: true })
      assert.strictEqual(yield* Fiber.join(waiter), 'acquired')
    })
  )

  it.effect('stops waiting when interrupted', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const lock = yield* lockPath
      yield* fs.makeDirectory(lock)
      const waiter = yield* Lockfile.acquire(lock, {
        stale: '60 seconds',
        timeout: '1 minute',
      }).pipe(Effect.scoped, Effect.forkChild)

      yield* Effect.sleep('300 millis')
      yield* Fiber.interrupt(waiter).pipe(
        Effect.timeoutOrElse({
          duration: '1 second',
          orElse: () =>
            Effect.die('the wait for the lock ignored the interrupt'),
        })
      )
      assert.isTrue(yield* fs.exists(lock))
    })
  )

  it.effect('takes over a lock its holder stopped touching', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const lock = yield* lockPath
      yield* fs.makeDirectory(lock)
      const longAgo = DateTime.toDate(
        DateTime.subtract(yield* DateTime.now, { minutes: 2 })
      )
      yield* fs.utimes(lock, longAgo, longAgo)

      yield* Lockfile.acquire(lock, {
        stale: '60 seconds',
        timeout: '1 second',
      }).pipe(Effect.scoped)
    })
  )

  it.effect('gives up when the holder keeps the lock', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const lock = yield* lockPath
      yield* fs.makeDirectory(lock)

      const result = yield* Lockfile.acquire(lock, {
        stale: '60 seconds',
        timeout: '600 millis',
      }).pipe(Effect.scoped, Effect.result)

      assertFailure(result, new Lockfile.LockTimeoutError({ path: lock }))
      assert.isTrue(yield* fs.exists(lock))
    })
  )
})
