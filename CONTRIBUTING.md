# Contributing to The Family Ledger

Thanks for taking a look. This is a small, purpose-built project — the bar for contributing is "does it work, is it readable, does it fit."

## Development Setup

```bash
git clone https://github.com/ZoneMix/family-ledger.git
cd family-ledger
npm install
```

You'll need a running Actual Budget server to point the dashboard at. The easiest way is `./setup.sh`, which brings up `actual-server` in Docker and writes a `.env` for you. Once you have `.env` populated (`ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`), you can iterate on the dashboard directly with:

```bash
npm start
```

There's no build step for the frontend — `public/js/*.js` are loaded as native ES modules, so a browser refresh is all you need after an edit.

## Branch / PR Workflow

1. Fork the repo, branch off `main`.
2. Keep PRs focused — one change, one PR.
3. Make sure CI passes before requesting review (see below).
4. Open a PR with a short description of *why*, not just *what*.

## Code Style

- **Small files.** `src/*.js` files stay in the 60-260 line range on purpose — one concern per file. If a change grows a file past ~300 lines, consider splitting it.
- **Small functions.** Prefer several named helpers over one long function.
- **Explicit error handling.** Every `catch` either logs with context or returns a meaningful HTTP error — never swallow silently.
- **Cents vs. dollars.** The `/api/budget` payload is integer cents everywhere *except* `networth` and `goals`, which are dollars. Keep new fields consistent with whichever section they live in — see `CLAUDE.md` for the full breakdown.
- **No heredocs in shell scripts.** `setup.sh`, `update.sh`, `backup.sh`, `seed-demo.sh` avoid `<< 'EOF'`-style heredocs on principle — multi-line content goes through `printf`/`{ ... } >`. Keep new shell code consistent with that.

## Version Pinning Policy

`docker-compose.yml` pins `actualbudget/actual-server` to an exact tag, and `package.json` pins `@actual-app/api` to the matching exact version. These two numbers are a **tested pair** — a PR that bumps one without the other, or that switches either to a range (`^`, `~`, `latest`), will be rejected. See `docs/UPGRADING.md` for why.

## CI

Every PR runs:

- `node --check` against `server.js`, `src/*.js`, `scripts/seed-demo.js`, and `scripts/dev/css-audit.mjs` (syntax validation — there's no test suite yet)
- `node scripts/dev/css-audit.mjs` (fails if `styles.css` has a selector nothing in `public/` actually uses)
- `shellcheck` against `setup.sh`, `update.sh`, `backup.sh`, `seed-demo.sh`
- `docker build .` (the image has to build cleanly; nothing is pushed)

All of these must pass before a PR can merge.

## Reporting Issues

Use the issue templates (bug report / feature request). For bugs, please include the output of `docker compose logs dashboard` and what device/browser you were on — most reported issues turn out to be environment-specific (port conflicts, phone not on the home network, stale Actual session).

## Using Claude Code

This repo ships a `CLAUDE.md` at the root with an architecture map, the `/api/budget` payload shape, and the cents-vs-dollars convention. If you're using [Claude Code](https://claude.com/claude-code), it reads that file automatically — start there before asking broader questions about how the pieces fit together.
