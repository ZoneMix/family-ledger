---
name: Bug report
about: Something isn't working right
title: "[Bug] "
labels: bug
assignees: ''
---

## What happened?

A clear description of the problem.

## What did you expect to happen?

## Steps to reproduce

1.
2.
3.

## `./setup.sh` output

If this showed up during first-time setup, paste the terminal output (redact your password/Sync ID if you pasted them into the terminal):

```
paste here
```

## `docker compose logs dashboard`

```
paste here
```

If relevant, also include `docker compose logs actual-server`.

## Environment

- **Device/browser accessing the dashboard:** (e.g. iPhone Safari, Android Chrome, desktop Firefox)
- **Server this is running on:** (e.g. Raspberry Pi 4, old laptop, NAS)
- **OS:** (e.g. Raspberry Pi OS, Ubuntu 22.04, Synology DSM)
- **`docker --version` / `docker compose version`:**
- **Are the dashboard and phone on the same home network?** yes / no

## Anything else?

Anything else that might help — recent changes to `.env` or the JSON config files, whether this started after an upgrade, etc.
