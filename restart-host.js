/**
 * Detached relauncher for the DSH desktop app.
 *
 * This script is spawned with `detached: true` by the restart bundle's Host
 * half, so it runs outside the app's process tree and survives the app exiting.
 * Its job is:
 *
 *  1. ask the Electron main process to quit through its own quit path, and
 *     terminate it when it will not;
 *  2. wait until the app is gone (a new launch would lose the single-instance
 *     lock otherwise, and simply be discarded);
 *  3. start the app executable again, then exit.
 *
 * Step 1 is the interesting one. The tray's own quit button calls `app.quit()`
 * inside the Electron main process, which runs the shell's quit path: it closes
 * the Host over IPC and removes the tray icon. Nothing outside that process can
 * call `app.quit()`, so the next best thing is the notification Windows sends
 * to a window when the session is ending. The shell listens for it and marks
 * the session as ending, which makes the next close of its window a real close
 * instead of a hide-to-tray. `graceful-quit.ps1` posts that notification and
 * then the close, so the shell quits itself: no stale tray icon left behind,
 * the Host stops over its normal shutdown, and the quit is recorded. When that
 * does not happen the process is terminated, which is what this script always
 * did before.
 *
 * Hazards learned the hard way, which shape the implementation:
 *
 *  - **Never tree-kill the process that contains this relauncher.** The
 *    relauncher is spawned by the Host, which is a child of the Electron main
 *    process, so `taskkill /PID <main> /T /F` would kill the relauncher too —
 *    leaving the user with no window and nothing to start it again. Quitting
 *    therefore targets specific pids and never recurses into children.
 *  - **Never send a bare `WM_CLOSE` and expect a quit.** The shell treats it as
 *    the user closing the window and hides to the tray instead, unless it has
 *    already been told the session is ending — the reason the close is only
 *    posted by `graceful-quit.ps1`, after the session-end notification.
 *  - **Terminate the main process before the Host.** The shell treats any Host
 *    exit it did not request as fatal and reports it, so stopping the Host first
 *    flashed an "application stopped" dialog on every restart.
 *
 * Every step is appended to a log file under the temporary directory, because
 * this process has no console attached and a failed restart must be diagnosable
 * afterwards. The file is truncated per run and kept small.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, statSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where this relauncher records what it did. */
const LOG = join(tmpdir(), 'dsh-restart.log')

/** This script's directory, which also holds the session-end helper. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** The helper that delivers the session-end notification and the close. */
const GRACE_SCRIPT = join(HERE, 'graceful-quit.ps1')

/** Start a fresh log once the previous one grows past this size. */
const LOG_MAX_BYTES = 256 * 1024

/**
 * Append one timestamped line to the log, ignoring logging failures.
 * @param message - the line to record.
 */
function log(message) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // The restart matters more than its log.
  }
}

/**
 * Keep the log from growing without bound across many restarts.
 *
 * A restart appends a handful of lines, so truncating only when the file is
 * already large preserves recent history while capping disk use.
 */
function trimLog() {
  try {
    if (existsSync(LOG) && statSync(LOG).size > LOG_MAX_BYTES) truncateSync(LOG, 0)
  } catch {
    // A log that cannot be trimmed is not worth failing a restart over.
  }
}

/**
 * Read `--name value` pairs from argv.
 * @param argv - arguments after the script path.
 * @returns the parsed values.
 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (typeof key === 'string' && key.startsWith('--')) out[key.slice(2)] = argv[i + 1]
  }
  return out
}

/**
 * Whether a pid names a live process.
 * @param pid - the pid to probe.
 * @returns true while it exists.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Run `taskkill` and resolve with its exit code, never rejecting.
 *
 * Output is deliberately not piped: capturing another program's stdio fails
 * under the app's confined modes, and this result is not needed. The call is
 * bounded, because `taskkill` without `/F` can sit waiting for a window that
 * never acknowledges the close — that alone once cost 15 seconds per restart.
 *
 * @param args - taskkill arguments.
 * @param timeoutMs - how long to wait before abandoning the call.
 * @returns the exit code, or -1 when it could not run or timed out.
 */
function taskkill(args, timeoutMs = 5000) {
  return new Promise((resolvePromise) => {
    let settled = false
    /** Resolve once, ignoring later callbacks from an abandoned child. */
    const settle = (code) => {
      if (settled) return
      settled = true
      resolvePromise(code)
    }
    try {
      const child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' })
      const timer = setTimeout(() => {
        log(`taskkill ${args.join(' ')} timed out after ${timeoutMs}ms`)
        try {
          child.kill()
        } catch {
          // Already gone.
        }
        settle(-1)
      }, timeoutMs)
      child.on('error', (error) => {
        clearTimeout(timer)
        log(`taskkill ${args.join(' ')} failed to start: ${error.message}`)
        settle(-1)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        settle(code ?? -1)
      })
    } catch (error) {
      log(`taskkill ${args.join(' ')} threw: ${error.message}`)
      settle(-1)
    }
  })
}

/**
 * Terminate one pid.
 *
 * `taskkill /F` is the reliable path on Windows for a process this one does not
 * own, and it does not send WM_CLOSE, so the target's quit-confirmation flow
 * never runs. `process.kill` is tried first only as a cheap direct attempt.
 *
 * @param pid - the process to terminate.
 */
async function hardKill(pid) {
  await taskkill(['/PID', String(pid), '/F'], 5000)
  if (isAlive(pid)) {
    // A signal is a last resort for a process that ignored the forced kill.
    try {
      process.kill(pid)
      log(`sent signal to ${pid} after taskkill`)
    } catch (error) {
      log(`process.kill ${pid} failed: ${error.message}`)
    }
  }
}

/**
 * Ask the shell to quit the way its tray menu does.
 *
 * `graceful-quit.ps1` posts the session-end notification to the shell's window
 * and then closes it, which is the only route to `app.quit()` open to a process
 * outside the Electron main process. The request is best effort: a shell that
 * ignores it is terminated by the caller.
 *
 * Output is not captured — the helper appends its own diagnostics to the same
 * log file — so this only needs the exit code.
 *
 * @param mainPid - the Electron main process that owns the window.
 * @returns whether the helper ran to completion.
 */
async function requestGracefulQuit(mainPid) {
  if (!existsSync(GRACE_SCRIPT)) {
    log(`session-end helper missing at ${GRACE_SCRIPT}`)
    return false
  }
  return new Promise((resolvePromise) => {
    let settled = false
    /** Resolve once, ignoring later callbacks from an abandoned child. */
    const settle = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    try {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', GRACE_SCRIPT,
          '-TargetPid', String(mainPid),
          '-Mode', 'quit',
          '-LogPath', LOG,
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
      const timer = setTimeout(() => {
        log('session-end request did not finish; abandoning it')
        try {
          child.kill()
        } catch {
          // Already gone.
        }
        settle(false)
      }, 15000)
      child.on('error', (error) => {
        clearTimeout(timer)
        log(`session-end request failed to start: ${error.message}`)
        settle(false)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        log(`session-end request exited with ${code}`)
        settle(code === 0)
      })
    } catch (error) {
      log(`session-end request threw: ${error.message}`)
      settle(false)
    }
  })
}


const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** One polling interval while waiting for a process to exit. */
const POLL_MS = 200

/**
 * Wait until a pid disappears.
 * @param pid - the pid to watch.
 * @param timeoutMs - how long to wait.
 * @returns true when the process is gone.
 */
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(POLL_MS)
  }
  return !isAlive(pid)
}

/** How long the shell gets to quit by itself after the session-end request. */
const GRACE_WAIT_MS = 10000

/**
 * Stop the app, then let the caller start a fresh instance.
 *
 * Preference order:
 *
 *  1. ask the shell to quit through its own quit path (`requestGracefulQuit`);
 *  2. if it is still running after `GRACE_WAIT_MS`, terminate the main process;
 *  3. let the Host notice the dropped IPC channel and shut down by itself;
 *  4. only force the Host when it outlives its parent, when nothing is left to
 *     report it.
 *
 * Step 1 makes the restart indistinguishable from the tray's quit: the shell
 * runs `finishQuit()`, which disposes the tray icon (so no ghost icon is left
 * for Explorer to clean up on the next hover), records the quit in the update
 * journal and closes the Host over IPC. Steps 2-4 are the guaranteed fallback,
 * and the only path when the shell ignores the session-end notification.
 *
 * Nothing here sends a bare `WM_CLOSE`: the shell reads that as the user closing
 * the window and hides to the tray, so it would only burn the timeout.
 *
 * The shell treats any Host exit it did not request as fatal: its
 * `child.once('close')` calls `fail()` for every code, including 0, which opens
 * the desktop's "application stopped" dialog. Killing the Host first therefore
 * flashed an error dialog even though the restart succeeded.
 *
 * `taskkill /T` is never used: this relauncher is a descendant of the Host, so a
 * tree kill would destroy the very process meant to start the app again.
 *
 * @param mainPid - the Electron main process pid (owns the window).
 * @param hostPid - the Host process pid, or undefined when unknown.
 * @returns whether the app is gone.
 */
async function quitApp(mainPid, hostPid) {
  if (!isAlive(mainPid)) {
    log(`main process ${mainPid} already gone`)
    return true
  }

  log(`asking main process ${mainPid} to quit through its session-end path`)
  if (await requestGracefulQuit(mainPid)) {
    if (await waitGone(mainPid, GRACE_WAIT_MS)) log(`main process ${mainPid} quit by itself`)
    else log(`main process ${mainPid} ignored the session-end request`)
  }

  if (isAlive(mainPid)) {
    log(`terminating main process ${mainPid}`)
    await hardKill(mainPid)
    if (!(await waitGone(mainPid, 8000))) {
      log(`main process ${mainPid} STILL alive after termination`)
      return false
    }
  }
  log(`main process ${mainPid} exited`)

  // Let the Host notice the dropped IPC channel and shut itself down; killing it
  // while the main process could still observe it is what produced the dialog.
  if (Number.isSafeInteger(hostPid) && hostPid > 0) {
    if (await waitGone(hostPid, 6000)) {
      log(`host ${hostPid} exited`)
    } else {
      log(`host ${hostPid} outlived its parent; terminating`)
      await hardKill(hostPid)
      if (!(await waitGone(hostPid, 5000))) log(`host ${hostPid} did not exit`)
    }
  }

  return true
}

/**
 * Start the app again, detached from this relauncher.
 * @param exe - the app executable.
 * @param cwd - its working directory, when known.
 * @returns the new process pid, or undefined.
 */
function startApp(exe, cwd) {
  if (!existsSync(exe)) {
    log(`cannot start: executable missing at ${exe}`)
    return undefined
  }
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    ...(cwd === undefined ? {} : { cwd }),
    // This relauncher runs with ELECTRON_RUN_AS_NODE=1; the launched app must
    // not inherit it, or it would start as a bare Node process.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
  })
  child.on('error', (error) => {
    log(`spawn error: ${error.message}`)
  })
  child.unref()
  return child.pid
}

/** Entry point. */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const mainPid = Number(args['quit-pid'])
  const hostPid = Number(args['host-pid'])
  const exe = args.exe
  const cwd = args.cwd
  const delayMs = Number(args['delay-ms']) || 900

  trimLog()
  log(`--- relauncher start (main=${mainPid} host=${hostPid} exe=${exe})`)

  if (!Number.isSafeInteger(mainPid) || mainPid <= 0 || typeof exe !== 'string' || exe.length === 0) {
    log('invalid arguments; aborting without touching any process')
    return
  }

  const gone = await quitApp(mainPid, Number.isSafeInteger(hostPid) ? hostPid : undefined)
  if (!gone) {
    log('could not stop the app; not starting a second instance')
    return
  }

  await sleep(delayMs)

  const started = startApp(exe, typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined)
  log(started === undefined ? 'failed to start the app' : `started the app as pid ${started}`)
}

main().catch((error) => {
  log(`relauncher crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})
