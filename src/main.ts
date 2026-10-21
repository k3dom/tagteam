import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { Command } from 'effect/cli'

import PackageJson from '#package.json' with { type: 'json' }

Command.make('tagteam').pipe(
  Command.withDescription(PackageJson.description),
  Command.run({ version: PackageJson.version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
