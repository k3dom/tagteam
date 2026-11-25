import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api'

import * as Account from '#/domain/account.ts'
import * as Mode from '#/domain/mode.ts'

const ModeStruct = Schema.Struct({ mode: Mode.Mode })

export class Group extends HttpApiGroup.make('rotation')
  .annotate(
    OpenApi.Description,
    'Choose whether tagteam switches Claude Code between the accounts by itself, or switch it by hand'
  )
  .add(
    HttpApiEndpoint.get('mode', '/mode', { success: ModeStruct }).annotate(
      OpenApi.Summary,
      'Whether tagteam switches between the accounts by itself'
    )
  )
  .add(
    HttpApiEndpoint.put('setMode', '/mode', { payload: ModeStruct })
      .annotate(OpenApi.Summary, 'Turn automatic switching on or off')
      .annotate(
        OpenApi.Description,
        'Turn automatic switching on or off. Turned on, it switches right away if Claude Code should be on another account.'
      )
  )
  .add(
    HttpApiEndpoint.post('switch', '/switch', {
      payload: Schema.Struct({ account: Account.Selector }),
      success: Schema.Struct({
        email: Schema.String,
        switched: Schema.Boolean.annotate({
          description: 'Whether Claude Code was on another account before',
        }),
      }),
      error: [
        Account.NotFoundError,
        Account.NotLoggedInError,
        Account.UnmanagedError,
        Account.ClaudeCodeConfigError,
        Account.ClaudeCodeBusyError,
      ],
    })
      .annotate(OpenApi.Summary, 'Switch Claude Code to an account')
      .annotate(
        OpenApi.Description,
        'Switch Claude Code to an account and turn automatic switching off, so that it stays there'
      )
  ) {}
