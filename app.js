'use strict';

/**
 * pm2-job-reaper
 *
 * For every app PM2 runs, this module:
 *   1. puts the app's root process into its own named Job Object as soon as it
 *      comes online, so every process it spawns from then on joins the job;
 *   2. sweeps descendants that were spawned before the job was assigned;
 *   3. once the root process has exited (crash, stop, restart, delete), calls
 *      TerminateJobObject to kill whatever is left.
 *
 * Job handles are also duplicated into the PM2 daemon so the named jobs outlive
 * a restart of this module; state is persisted in PM2_HOME.
 */

var pmx = require('pmx');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TAG = '[job-reaper]';
let cfg = { debug: false };

function log(level, msg) {
  if (level === 'debug' && !cfg.debug) return;
  const line = `${TAG} ${level.toUpperCase()} ${msg}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

function applyConfig(conf) {
  const bool = (v) => v === true || String(v).toLowerCase() === 'true';
  const num = (v, d) => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    pollIntervalMs: Math.max(1000, num(conf.pollIntervalMs, 5000)),
    exitCode: num(conf.exitCode, 1) >>> 0,
    dryRun: bool(conf.dryRun),
    debug: bool(conf.debug),
    ignore: new Set(
      String(conf.ignore || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  };
}

pmx.initModule({

  // Options related to the display style on Keymetrics
  widget : {

    logo : 'https://github.com/rckok/pm2-job-reaper/blob/09823edffb90d90c206bdb092b8aa603b0ff1d4f/assets/logo-300.png',

    theme: ['#141A1F', '#222222', '#3ff', '#3ff'],

    el : {
      probes  : false,
      actions : false
    },

    block : {
      actions : false,
      issues  : false,
      meta    : false,
      main_probes : []
    }

  }

}, function(err, conf) {
  function main() {
    cfg = applyConfig(conf);

    const w = require('./lib/win32');
    const pm2 = require('pm2');
    const { C } = w;

    const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
    const STATE_FILE = path.join(PM2_HOME, 'job-reaper-state.json');
    const ROOT_ACCESS =
      C.SYNCHRONIZE | C.PROCESS_QUERY_LIMITED_INFORMATION | C.PROCESS_SET_QUOTA | C.PROCESS_TERMINATE;
    const CHILD_ACCESS = C.PROCESS_QUERY_LIMITED_INFORMATION | C.PROCESS_SET_QUOTA | C.PROCESS_TERMINATE;
    const MAX_SWEEP_PASSES = 3;
    const MAX_REAP_FAILURES = 5;
    const OWN_PM_ID = process.env.pm_id !== undefined ? Number(process.env.pm_id) : null;

    /** jobName -> { jobName, pmId, appName, pid, ctime, remote, hJob, hRoot, reapFailures } */
    const tracked = new Map();
    /** "pmId:pid" keys we failed to adopt, so we don't retry every tick. */
    const failed = new Set();

    const label = (e) => `${e.appName}[${e.pmId}] pid ${e.pid}`;
    const key = (pmId, pid) => `${pmId}:${pid}`;

    // ---------------------------------------------------------------- daemon

    function openDaemon() {
      let pid = 0;
      try {
        pid = parseInt(fs.readFileSync(path.join(PM2_HOME, 'pm2.pid'), 'utf8').trim(), 10) || 0;
      } catch (_) {
        /* fall through */
      }
      if (!pid) pid = process.ppid;
      const { h, err } = w.openProcess(pid, C.PROCESS_DUP_HANDLE | C.PROCESS_QUERY_LIMITED_INFORMATION);
      if (!h) {
        log('warn', `cannot open PM2 daemon (pid ${pid}, error ${err}); tracking will not survive a restart of this module`);
        return null;
      }
      return { pid, h, ctime: w.creationTime(h) };
    }

    const daemon = openDaemon();

    // ----------------------------------------------------------------- state

    function saveState() {
      const data = {
        version: 1,
        daemon: daemon && { pid: daemon.pid, ctime: daemon.ctime },
        jobs: [...tracked.values()].map(({ jobName, pmId, appName, pid, ctime, remote }) => ({
          jobName,
          pmId,
          appName,
          pid,
          ctime,
          remote,
        })),
      };
      const tmp = `${STATE_FILE}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, STATE_FILE);
      } catch (e) {
        log('warn', `could not save state: ${e.message}`);
      }
    }

    function loadState() {
      let s;
      try {
        s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      } catch (_) {
        return;
      }
      const sameDaemon =
        daemon && s.daemon && s.daemon.pid === daemon.pid && s.daemon.ctime === daemon.ctime;
      if (!sameDaemon) {
        // Remote handle values from another daemon instance must never be closed: they'd hit unrelated handles.
        log('info', 'saved state belongs to a previous PM2 daemon; discarding it');
        return;
      }
      for (const j of s.jobs || []) {
        const hJob = w.openJob(j.jobName);
        if (!hJob) {
          log('warn', `job for ${label(j)} no longer exists; dropping it`);
          continue;
        }
        let hRoot = w.openProcess(j.pid, ROOT_ACCESS).h;
        if (hRoot) {
          let same = false;
          try {
            same = w.creationTime(hRoot) === j.ctime;
          } catch (_) {
            /* treat as gone */
          }
          if (!same) {
            w.closeHandle(hRoot); // PID has been reused; the original root is gone
            hRoot = 0;
          }
        }
        tracked.set(j.jobName, { ...j, hJob, hRoot, reapFailures: 0 });
        log('info', `re-attached to job for ${label(j)}${hRoot ? '' : ' (root already exited)'}`);
      }
    }

    // ---------------------------------------------------------------- adopt

    /** Adds descendants that predate the job assignment. Returns how many were added. */
    function sweep(entry) {
      let total = 0;
      for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
        const children = new Map();
        for (const p of w.listProcesses()) {
          if (p.pid === p.ppid || p.pid === 0) continue;
          if (!children.has(p.ppid)) children.set(p.ppid, []);
          children.get(p.ppid).push(p);
        }

        let added = 0;
        const seen = new Set([entry.pid]);
        const queue = [{ pid: entry.pid, ctime: BigInt(entry.ctime) }];
        while (queue.length) {
          const parent = queue.shift();
          for (const child of children.get(parent.pid) || []) {
            if (seen.has(child.pid)) continue;
            seen.add(child.pid);
            const { h, err } = w.openProcess(child.pid, CHILD_ACCESS);
            if (!h) {
              log('debug', `sweep: cannot open ${child.exe} pid ${child.pid} (error ${err})`);
              continue;
            }
            try {
              const ct = BigInt(w.creationTime(h));
              // Windows never reparents, so a PPID can be stale. A real child is always younger than its parent.
              if (ct < parent.ctime) continue;
              if (!w.isInJob(h, entry.hJob)) {
                w.assign(entry.hJob, h);
                added++;
                log('debug', `sweep: added ${child.exe} pid ${child.pid} to job of ${label(entry)}`);
              }
              queue.push({ pid: child.pid, ctime: ct });
            } catch (e) {
              log('warn', `sweep: ${child.exe} pid ${child.pid}: ${e.message}`);
            } finally {
              w.closeHandle(h);
            }
          }
        }
        total += added;
        if (!added) break;
      }
      return total;
    }

    function adopt(app) {
      const base = { pmId: app.pm_id, appName: app.name, pid: app.pid };
      const { h: hRoot, err } = w.openProcess(app.pid, ROOT_ACCESS);
      if (!hRoot) {
        log('warn', `cannot open ${label(base)} (error ${err}); not tracked`);
        failed.add(key(app.pm_id, app.pid));
        return;
      }

      let hJob = 0;
      try {
        const ctime = w.creationTime(hRoot);
        const jobName = `Local\\pm2-job-reaper-${app.pm_id}-${app.pid}-${ctime}`;
        const created = w.createJob(jobName);
        hJob = created.h;
        w.assign(hJob, hRoot);

        const entry = { ...base, jobName, ctime, remote: null, hJob, hRoot, reapFailures: 0 };
        if (daemon && !created.existed) {
          entry.remote = w.duplicateInto(daemon.h, hJob);
          if (entry.remote === null) log('warn', `could not hand job of ${label(entry)} to the PM2 daemon (error ${w.lastError()})`);
        }
        tracked.set(jobName, entry);
        saveState();

        const swept = sweep(entry);
        log('info', `tracking ${label(entry)}${swept ? ` (+${swept} pre-existing descendant(s))` : ''}`);
      } catch (e) {
        const hint =
          e.code === C.ERROR_ACCESS_DENIED
            ? ' — the process may be elevated, owned by another user, or in a job that forbids nesting'
            : '';
        log('warn', `cannot track ${label(base)}: ${e.message}${hint}`);
        failed.add(key(app.pm_id, app.pid));
        w.closeHandle(hJob);
        w.closeHandle(hRoot);
      }
    }

    // ----------------------------------------------------------------- reap

    function release(entry) {
      if (entry.remote !== null && entry.remote !== undefined && daemon) {
        if (!w.closeRemoteHandle(daemon.h, entry.remote)) {
          log('debug', `could not close daemon-side job handle for ${label(entry)} (error ${w.lastError()})`);
        }
      }
      w.closeHandle(entry.hJob);
      w.closeHandle(entry.hRoot);
      tracked.delete(entry.jobName);
    }

    function reap(entry) {
      const active = w.activeProcessCount(entry.hJob);
      if (active === 0) {
        log('debug', `${label(entry)} exited cleanly; nothing left in its job`);
        release(entry);
        return;
      }
      const what = active === null ? 'any leftover processes' : `${active} leftover process(es)`;
      if (cfg.dryRun) {
        log('info', `[dry-run] would terminate ${what} of ${label(entry)}`);
        release(entry);
        return;
      }
      try {
        w.terminateJob(entry.hJob, cfg.exitCode);
        log('info', `terminated ${what} of ${label(entry)}`);
        release(entry);
      } catch (e) {
        entry.reapFailures++;
        if (entry.reapFailures >= MAX_REAP_FAILURES) {
          log('error', `giving up on ${label(entry)} after ${entry.reapFailures} attempts: ${e.message}`);
          release(entry);
        } else {
          log('warn', `could not terminate job of ${label(entry)} (attempt ${entry.reapFailures}): ${e.message}`);
        }
      }
    }

    // ------------------------------------------------------------ reconcile

    const pm2List = () => new Promise((res, rej) => pm2.list((e, list) => (e ? rej(e) : res(list))));

    function eligible(app) {
      const env = app.pm2_env || {};
      if (env.pmx_module) return false;
      if (OWN_PM_ID !== null && app.pm_id === OWN_PM_ID) return false;
      if (cfg.ignore.has(app.name)) return false;
      return env.status === 'online' && app.pid > 0;
    }

    async function reconcileOnce() {
      // Reap first, so a restarted app that reused its old PID can be adopted in the same pass.
      const before = tracked.size;
      for (const entry of [...tracked.values()]) {
        if (!entry.hRoot || w.hasExited(entry.hRoot)) reap(entry);
      }
      if (tracked.size !== before) saveState();

      const list = await pm2List();
      const live = new Set();
      const trackedKeys = new Set([...tracked.values()].map((e) => key(e.pmId, e.pid)));
      for (const app of list) {
        if (!eligible(app)) continue;
        const k = key(app.pm_id, app.pid);
        live.add(k);
        if (trackedKeys.has(k) || failed.has(k)) continue;
        adopt(app);
      }
      for (const k of failed) if (!live.has(k)) failed.delete(k);
    }

    let busy = false;
    let again = false;
    async function reconcile(reason) {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          log('debug', `reconcile (${reason})`);
          await reconcileOnce();
        } while (again);
      } catch (e) {
        log('error', `reconcile failed: ${e.stack || e.message}`);
      } finally {
        busy = false;
      }
    }

    // ----------------------------------------------------------------- boot

    loadState();

    pm2.connect((err) => {
      if (err) {
        log('error', `cannot connect to PM2: ${err.message}`);
        process.exit(1);
      }
      pm2.launchBus((busErr, bus) => {
        if (busErr) {
          log('error', `cannot open PM2 event bus: ${busErr.message}; relying on polling only`);
        } else {
          bus.on('process:event', (packet) => {
            const ev = packet && packet.event;
            if (['online', 'exit', 'stop', 'restart', 'delete'].includes(ev)) {
              setImmediate(() => reconcile(`event:${ev}`));
            }
          });
        }
        log(
          'info',
          `started (poll ${cfg.pollIntervalMs} ms${cfg.dryRun ? ', DRY RUN' : ''}` +
            `${cfg.ignore.size ? `, ignoring ${[...cfg.ignore].join(', ')}` : ''})`
        );
        reconcile('startup');
        setInterval(() => reconcile('poll'), cfg.pollIntervalMs);
      });
    });

    // Jobs are not kill-on-close, so exiting here leaves every app running. The daemon-side
    // handles keep the named jobs alive, and the next start of this module re-attaches to them.
    const shutdown = () => {
      saveState();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('message', (msg) => msg === 'shutdown' && shutdown());
  }

  if (err) {
    log('error', err);
  }
  if (process.platform === 'win32') {
    main();
  } else {
    log('warn', 'this module only works on Windows; idling');
    setInterval(() => {}, 1 << 30);
  }
});
