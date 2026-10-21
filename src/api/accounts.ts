import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api'

import * as Account from '#/domain/account.ts'

const Email = Schema.Struct({ email: Schema.String })

export class Group extends HttpApiGroup.make('accounts')
  .annotate(
    OpenApi.Description,
    'Manage the accounts that tagteam rotates Claude Code between'
  )
  .add(
    HttpApiEndpoint.get('list', '/accounts', {
      success: Schema.Array(Account.Account),
      error: Account.ClaudeCodeConfigError,
    })
      .annotate(OpenApi.Summary, 'List the accounts with their usage')
      .annotate(
        OpenApi.Description,
        'List the accounts in priority order with their usage, as the daemon last checked it'
      )
  )
  .add(
    HttpApiEndpoint.post('add', '/accounts', {
      payload: Schema.Struct({
        main: Schema.Boolean.annotate({
          description: 'Make it the main account',
        }),
      }),
      success: Schema.Struct({
        email: Schema.String,
        position: Schema.Int.annotate({
          description: 'Its number in the priority order, from 1',
        }),
        added: Schema.Boolean.annotate({
          description: 'Whether it is new rather than updated',
        }),
      }),
      error: [Account.NotLoggedInError, Account.ClaudeCodeConfigError],
    })
      .annotate(OpenApi.Summary, 'Add the account Claude Code is logged into')
      .annotate(
        OpenApi.Description,
        'Add the account Claude Code is logged into, or update its stored login'
      )
  )
  .add(
    HttpApiEndpoint.delete('remove', '/accounts/:account', {
      params: { account: Account.Selector },
      success: Email,
      error: Account.NotFoundError,
    }).annotate(OpenApi.Summary, 'Stop managing an account')
  )
  .add(
    HttpApiEndpoint.put('main', '/main', {
      payload: Schema.Struct({ account: Account.Selector }),
      success: Email,
      error: Account.NotFoundError,
    }).annotate(OpenApi.Summary, 'Make an account the main one')
  ) {}
