# Balance \& Usage Dock

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web UI plugin. It shows the DeepSeek account balance, today's spend, and a per-response token chart to the left of the composer's *Performance \& usage* pills.



Requires DSH Desktop (or a Web profile with `dsh-host-webserver`, `dsh-session-projection`, and a credential provider) and a DeepSeek account signed in under Settings → Account. No npm dependencies, no build step.

## Features

* **Live balance** — topped-up balance plus granted credit, refreshed every 15 seconds and shown exactly as the account page shows it: each wallet truncated to cents, the headline being the sum of those two rows.
* **Today** — spend since the first reading of the current local day, from the account's cumulative cost counter.
* **Per-response token chart** — one bar per reply in the current session, sized by that reply's output tokens, so heavy and light replies are distinguishable at a glance. The newest reply is highlighted.
* **Details on hover** — exact account total, wallet split, session spend, and the newest reply's token count with its output/input split.

## Install

1. Open **Plugins** in the DSH sidebar.
2. Install this directory (or a Git address) with the plugin manager.
3. Restart DeepSeek Harness if the row does not appear. Disable or remove it from the same page to uninstall.

