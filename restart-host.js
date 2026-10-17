/**
 * Detached relauncher for the DSH desktop app.
 *
 * This script is spawned with `detached: true` by the restart bundle's Host
 * half, so it runs outside the app's process tree and survives the app exiting.
 * Its job is:
 *
 *  1. terminate the Electron main process;
 *  2. wait until the app is gone (a new launch would lose the single-instance
 *     lock otherwise, and simply be discarded);
 *  3. start the app executable again, then exit.
 *
 * Three hazards shape this implementation, each learned the hard way:
 *
 *  - **Never tree-kill the process that contains this relauncher.** The
 *    relauncher is spawned by the Host, which is a child of the Electron main
 *    process, so `taskkill /PID <main> /T /F` would kill the relauncher too —
 *    leaving the user with no window and nothing to start it again. Quitting
 *    therefore targets specific pids and never recurses into children.
 *  - **Never ask a window to close.** A plain `taskkill` sends WM_CLOSE, which
 *    the shell routes through its quit-confirmation flow (a modal dialog nobody
 *    can click here), so the window sat there until the timeout expired.
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
import { join } from 'node:path'

/** Where this relauncher records what it did. */
const LOG = join(tmpdir(), 'dsh-restart.log')

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
 * Sleep for a number of milliseconds.
 * @param ms - duration to wait.
 * @returns a promise resolved after the wait.
 */
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

/**
 * Stop the app, then let the caller start a fresh instance.
 *
 * The tray's quit is fast because it calls `app.quit()` inside the Electron main
 * process. From outside that process there is no way to reach `app.quit()`, and
 * a plain `taskkill` is worse than useless here: it sends WM_CLOSE, which the
 * shell routes through its quit-confirmation flow (`inspectQuit()` plus a modal
 * dialog). Nothing clicks that dialog, so the window sits there for the whole
 * timeout — the reason an earlier version appeared to hang.
 *
 * The order matters more than the mechanism:
 *
 *  1. terminate the main process first;
 *  2. let the Host notice the dropped IPC channel and shut down by itself;
 *  3. only force the Host if it outlives its parent, when nothing is left to
 *     report it.
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
 * @returns whether the main process is gone.
 */
async function quitApp(mainPid, hostPid) {
  if (!isAlive(mainPid)) {
    log(`main process ${mainPid} already gone`)
    return true
  }

  log(`terminating main process ${mainPid}`)
  await hardKill(mainPid)

  if (!(await waitGone(mainPid, 8000))) {
    log(`main process ${mainPid} STILL alive after termination`)
    return false
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
