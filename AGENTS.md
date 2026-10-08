# cache-keepalive

A Claude Code mod that keeps an idle session's prompt cache warm with short pings before it expires. `README.md` explains the parts.

## Project state

- 2026-10-08: public and installable; the maintainer is the only known user. Retires at the first report from another user.
- 2026-10-08: holds no user data; it reads only the session's own timing and the logged-in account's email, and keeps them in the plugin's local state. Retires if it ever stores or sends data off the user's machine.

## Rules

- Mod code: `$` is only passed to functions in the same file as the hooks (`claude plugin validate` refuses `$` across an import). Pure logic is exported from `hooks/register.ts` and tested in `tests/keepalive.test.ts`.

## Git workflow

- `main` changes only through a PR, squash-merged.
