# cache-keepalive

<p align="center"><strong>Keeps an idle Claude Code session's prompt cache warm, so the session you come back to does not start cold</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/federbenjamin/cache-keepalive" alt="License"></a>
</p>

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin for people who leave a long session open, step away, and come back to it. Claude Code caches the conversation's prompt for an hour (five minutes on some plans). Once that cache expires, your next message rebuilds the whole conversation: slower, and it costs more usage. This plugin sends a short ping two minutes before the cache would expire, so the cache stays warm while you are away.

## Install

Needs Claude Code; tested on 2.1.295.

```
claude plugin install cache-keepalive --marketplace federbenjamin/cache-keepalive
```

It starts in the next interactive session. There is nothing to configure.

## Features

- **Pings only while you are away.** A ping goes out only when the session is idle and the cache is between two minutes and fifteen seconds from expiring. Each ping is `keepalive ping. Reply only: ok`.
- **Capped per model.** At most 12 pings in a row on Opus and Fable, 6 on Sonnet, Haiku and any other model. On the 1-hour cache, that keeps an Opus session warm for about 12 hours.
- **Ends on a handoff.** The last ping asks the agent to run a `handoff` skill while the cache is still warm, so a fresh session can pick up from its document. Without a skill of that name, the call fails and the agent stops.
- **Resets on your own prompt.** Anything you type starts the count again.
- **Stops when pinging cannot help.** Two pings in a row that find the cache already cold stop the pings until you are back. So does a change of the logged-in account, since the cache belongs to the account.
- **Shows what it does.** The status line reads `keepalive 3/12` while it pings, and says why when it stops.

## Usage

Nothing to run: it works in every interactive session once installed. To stop it for one conversation:

```
/keepalive off
```

`/keepalive on` resumes it from your next request; `/keepalive` alone shows whether it is on.

## How it works

Every request in the main conversation restarts the cache's lifetime. The plugin records when the last main request started and checks every 30 seconds whether a ping is due. A subagent's request does not count.

- **Cache lifetime.** One hour by default. Five minutes when `FORCE_PROMPT_CACHING_5M` is `1` or `true`, or `CLAUDE_CODE_PROMPT_CACHE_TTL` is `5m`. Past your plan's usage, Claude Code drops to five minutes on its own; the first pings then find the cache cold and the plugin stops.
- **Cost.** Each ping is a real request: it reads the cached prompt and writes a one-word reply. The caps sit well below the number of pings that would cost as much as one cold rebuild.
- **Account check.** While a ping could still come, each 30-second check runs `claude auth status --json` to read the logged-in account.
- **Headless runs.** `claude -p` and other non-interactive sessions are never pinged.
- **Rewind.** A ping is not a rewind point; the rewind list holds only your own prompts.

## Contributing

Report a problem or ask a question in [Issues](https://github.com/federbenjamin/cache-keepalive/issues). Pull requests are welcome; see [CONTRIBUTING.md](https://github.com/federbenjamin/.github/blob/main/CONTRIBUTING.md), and report a security issue as [SECURITY.md](https://github.com/federbenjamin/.github/blob/main/SECURITY.md) says.

Run the plugin from a checkout:

```
claude --plugin-dir .
```

Checks, from the repo root:

```
claude plugin test .
tsc -p .
claude plugin validate .
```

`tsc -p .` reads the engine's types from `.claude-plugin/types/`, which Claude Code writes the first time it loads the plugin from this folder (any `claude --plugin-dir .` run).

## License

MIT © Benjamin Feder. See [LICENSE](LICENSE).
