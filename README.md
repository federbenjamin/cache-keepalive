# cache-keepalive

> **Moved.** This plugin now lives in [federbenjamin/feder-plugins](https://github.com/federbenjamin/feder-plugins) as `plugins/cache-keepalive`, where it is maintained alongside the other plugins. Install it with `claude plugin install cache-keepalive --marketplace federbenjamin/feder-plugins`. This repository is archived and no longer updated.

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that keeps an idle session's prompt cache warm, so the session you come back to does not start cold.

Claude Code caches the conversation's prompt for an hour (five minutes on some plans). Once that cache expires, your next message rebuilds the whole conversation: slower, and it costs more usage.

## Install

Needs Claude Code; tested on 2.1.295.

```
claude plugin install cache-keepalive --marketplace federbenjamin/cache-keepalive
```

It starts in the next interactive session.

Then turn off Claude Code's idle compaction by adding this to `~/.claude/settings.json`:

```json
"idleCompaction": false
```

Idle compaction summarizes a conversation of 200K tokens or more about 54 minutes into an idle spell, before the first ping is due. The pings would then keep only the summary warm, and the last ping's handoff would be written from it rather than from the full conversation.

## Features

- **Pings only while you are away.** When the session is idle and the cache is between two minutes and fifteen seconds from expiring, it sends `keepalive ping. Reply only: ok`.
- **Capped per model.** At most 12 pings in a row on Opus and Fable, 6 on Sonnet, Haiku and any other model.
- **Ends on a handoff.** The last ping asks the agent to write a handoff while the cache is still warm, so a fresh session can pick up from it. It runs your session-closing skill when one is installed, else your handoff skill.
- **Stops when pinging cannot help.** Your own prompt resets the count. Two pings in a row that find the cache already cold stop the pings until you are back, and so does a change of the logged-in account, since the cache belongs to the account. A ping that gets no response (an API error, or you interrupt it) is not sent again, and the status line says so. After a compaction it waits for the next request, which writes the new conversation's cache. `/keepalive off` stops them for the conversation until `/keepalive on`.

## How it works

- Each ping is a real request on your usage: it reads the cached prompt and writes a one-word reply. The caps sit well below the number of pings that would cost as much as one cold rebuild.
- It runs `claude auth status --json` to read the logged-in account, and keeps everything it records on your machine.
- `claude -p` and other non-interactive sessions are never pinged.

## Contributing

Report a problem or ask a question in [Issues](https://github.com/federbenjamin/cache-keepalive/issues). Pull requests are welcome; see [CONTRIBUTING.md](https://github.com/federbenjamin/.github/blob/main/CONTRIBUTING.md), and report a security issue as [SECURITY.md](https://github.com/federbenjamin/.github/blob/main/SECURITY.md) says.

Run the plugin from a checkout with `claude --plugin-dir .`, which also writes the engine types `tsc -p .` reads. Checks, from the repo root:

```
claude plugin test .
tsc -p .
claude plugin validate .
```

## License

MIT © Benjamin Feder. See [LICENSE](LICENSE).
