# pm2-job-reaper

A PM2 module for Windows that stops child processes from being orphaned when a PM2 app crashes, is stopped, restarted or deleted.

## How it works

1. When an app comes `online`, the module opens its root process and assigns it to a per-app named Job Object (`Local\pm2-job-reaper-<pm_id>-<pid>-<ctime>`). From that point every process the app spawns joins the job automatically, at any depth, whether or not its parent is still alive.
2. It then sweeps the app's existing descendants (up to three passes) and adds any that were spawned before the job was assigned. Candidates older than their supposed parent are skipped, because Windows never reparents and a stale PPID may point at an unrelated process.
3. When the root process has exited, the module calls `TerminateJobObject`, killing whatever is left, and logs how many processes that was. It never terminates a job while the root is still alive.

Triggers are PM2 bus events (`online`, `exit`, `stop`, `restart`, `delete`) plus a poll every `pollIntervalMs` as a safety net.

**Surviving module restarts.** The jobs are not kill-on-close, so the module crashing or being stopped leaves your apps alone. Each job handle is also duplicated into the PM2 daemon, which keeps the named job alive, and state is saved to `%PM2_HOME%\job-reaper-state.json`. On restart the module reopens every job by name. Apps that exited while the module was down are reaped immediately.

## Install

Requires Windows 8 / Server 2012 or later (nested jobs), Node 16+, and a 64-bit Node build.

```bat
cd pm2-job-reaper
npm install --omit=dev
pm2 install .
pm2 logs pm2-job-reaper
```

Recommended for production: start in dry-run mode, check the logs for a while, then turn it off.

```bat
pm2 set pm2-job-reaper:dryRun true
pm2 set pm2-job-reaper:dryRun false
```

## Configuration (`pm2 set pm2-job-reaper:<key> <value>`)

| Key              | Default   | Meaning                                                      |
| ---------------- | --------- | ------------------------------------------------------------ |
| `dryRun`         | `false`   | Log what would be killed instead of killing it.              |
| `ignore`         | _(empty)_ | Comma-separated PM2 app names to leave alone.                |
| `pollIntervalMs` | `5000`    | Safety-net reconcile interval (minimum 1000).                |
| `exitCode`       | `1`       | Exit code given to processes killed by `TerminateJobObject`. |
| `debug`          | `false`   | Verbose logging (sweep details, per-reconcile lines).        |

## Verify

```bat
node test\check-bindings.js
pm2 start test\leaky-app.js --name leaky --no-autorestart
tasklist /fi "imagename eq PING.EXE"
```

`leaky-app` spawns two `ping -t` processes, one of them orphaned through `cmd /c start /b`, then crashes after 10 seconds. Without the module both pings survive the crash; with it, the log shows `terminated 2 leftover process(es) of leaky[..]` and `tasklist` comes back empty. `pm2 delete leaky` when done.

## Limitations

- **Hard kill.** Leftovers are terminated, not asked to close. PM2 still performs its normal graceful stop of the app itself first.
- **Startup window.** Processes spawned before the job is assigned (typically tens of milliseconds after `online`) are caught by the sweep only while they are still linked to the app's tree. One that was spawned and orphaned within that window can't be found.
- **Breakaway.** Breakaway is not allowed on these jobs. An app that launches children with `CREATE_BREAKAWAY_FROM_JOB` will get an access-denied error on that spawn; add it to `ignore`.
- **Permissions.** The module runs as the PM2 user and cannot adopt processes that are elevated or owned by another account.
- **Daemon restarts.** `pm2 kill`, `pm2 update` or a reboot close the daemon-side handles, so the named jobs disappear. Saved state from a previous daemon is discarded, and apps are adopted fresh.
- **Intentional daemons.** Apps that deliberately leave long-lived processes behind need to be in `ignore`.
