// Only tagteam's daemon asks Anthropic, so polling `tagteam list` costs no
// usage requests.

import { v_flex, h_flex } from 'gpui-base'
import { View, div } from 'gpui-kit'
import { exec, theme } from 'herdr'

function roughly(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  }
  return hours % 24
    ? `${Math.floor(hours / 24)}d ${hours % 24}h`
    : `${Math.floor(hours / 24)}d`
}

export default class TagteamUsage extends View {
  init(_props, cx) {
    this.accounts = null
    this.error = null
    this.busy = false
    cx.timer.every(30000, (tick) => this.refresh(tick))
    this.refresh(cx)
  }

  refresh(cx) {
    if (this.busy) {
      return
    }
    this.busy = true
    cx.spawn(async (task) => {
      const result = await exec('tagteam', ['list', '--json']).catch(() => null)
      this.busy = false
      if (result === null) {
        this.error =
          "Couldn't run tagteam. Check that it is installed and on your PATH."
      } else if (result.code === 0) {
        this.accounts = JSON.parse(result.stdout).accounts
        this.error = null
      } else {
        this.error =
          result.stderr.trim() ||
          `tagteam list exited with code ${result.code}.`
      }
      task.notify()
    })
  }

  render() {
    const t = theme()
    const root = v_flex()
      .id('root')
      .min_w(250)
      .max_w(360)
      .px(10)
      .py(7)
      .gap(6)
      .text_size(12)
      .text_color(t.foreground)
    if (this.error) {
      return root.child(div().text_color(t.muted).child(this.error))
    }
    if (!this.accounts) {
      return root.child(div().text_color(t.dim).child('Loading usage…'))
    }
    if (this.accounts.length === 0) {
      return root.child(
        div()
          .text_color(t.muted)
          .child('No accounts yet. Run `tagteam add` to add one.')
      )
    }
    const now = Date.now()
    return root.children(
      this.accounts.map((account) => this.row(account, now, t))
    )
  }

  row(account, now, t) {
    const color = (utilization) =>
      utilization >= 90 ? t.ansi1 : utilization >= 75 ? t.ansi3 : t.accent
    const meter = (label, window) =>
      h_flex()
        .flex_none()
        .gap(5)
        .items_center()
        .whitespace_nowrap()
        .child(div().text_color(t.dim).child(label))
        .child(
          div()
            .w(44)
            .h(4)
            .rounded(2)
            .bg(t.border)
            .overflow_hidden()
            .child(
              div()
                .h_full()
                .w(`${Math.min(100, window?.utilization ?? 0)}%`)
                .bg(color(window?.utilization ?? 0))
            )
        )
        .child(
          div()
            .w(30)
            .text_right()
            .text_color(window ? t.foreground : t.dim)
            .child(window ? `${Math.round(window.utilization)}%` : '–')
        )
    const describe = (name, window) =>
      window &&
      `${name} ${Math.round(window.utilization)}%` +
        (window.resets_at
          ? `, resets in ${roughly(Date.parse(window.resets_at) - now)}`
          : '')

    const { usage, failure } = account
    const details = [
      [account.email, account.main && 'main', account.active && 'active']
        .filter(Boolean)
        .join(' · '),
      usage && describe('5-hour', usage.five_hour),
      usage && describe('Weekly', usage.seven_day),
      usage && `Checked ${roughly(now - Date.parse(usage.checked_at))} ago`,
      !usage &&
        !failure &&
        'Usage unknown until Claude Code refreshes its token on the next request',
      failure &&
        `${failure.message} Checking again in ${roughly(Date.parse(failure.retry_at) - now)}.`,
    ].filter(Boolean)

    return h_flex()
      .id(`account-${account.position}`)
      .gap(8)
      .items_center()
      .tooltip(details.join('\n'))
      .child(
        div()
          .size(6)
          .flex_none()
          .rounded(3)
          .bg(account.active ? t.accent : t.border)
      )
      .child(
        div()
          .w(96)
          .flex_none()
          .truncate()
          .text_color(account.active ? t.foreground : t.muted)
          .child(account.email.split('@')[0])
      )
      .children(
        usage
          ? [meter('5h', usage.five_hour), meter('wk', usage.seven_day)]
          : [div().flex_1().text_color(t.dim).child('usage unknown')]
      )
      .when(failure, (el) => el.child(div().text_color(t.ansi3).child('!')))
  }
}
