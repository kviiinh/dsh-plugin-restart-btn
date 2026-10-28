/**
 * Host half of the restart bundle.
 *
 * A full restart must look like "quit DSH, then start DSH". DSH's own
 * relaunch path lives in the Electron main process and only the browser shell
 * can reach it, while a plugin runs inside the Host child process. A plugin
 * therefore cannot restart the app from the inside: exiting would be read as a
 * crash, and a second launch would lose the single-instance lock race.
 *
 * The workaround is a detached relauncher process:
 *
 *  1. spawn `restart-host.js` with `detached: true` and `stdio: 'ignore'`, so it
 *     is not tied to this process, its console, or its process tree;
 *  2. answer the browser before the app goes away;
 *  3. the relauncher asks the shell to quit, waits until the app has exited,
 *     then launches the executable again.
 *
 * Step 3 needs the Electron main process pid, which owns the window. The Host
 * process's parent is that main process, so `process.ppid` reaches it.
 *
 * The Client half reaches this code over one private HTTP route rather than
 * `host.call`: that verb belongs to sandboxed dynamic packages, and ordinary
 * bundles reach the Host through a service or a route. A route keeps this
 * plugin free of generated typert bindings and of any other package's private
 * props — the failure that broke a previous version at startup.
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This file's directory, used to locate the relauncher script beside it. */
const here = dirname(fileURLToPath(import.meta.url))

/** Exact path the Client half posts to. Prefixed to stay clear of shipped routes. */
const ROUTE_PATH = '/plugins-local/dsh-restart'

/** Stable Loader plugin name. */
export const name = 'dsh-restart-button'

/** Services required before the route can be mounted. */
export const inject = ['webServer']

/**
 * Pause between the app exiting and the new instance starting. The relauncher
 * waits for the app's own processes to disappear, so this only covers the gap
 * before the executable is spawned.
 */
const RELAUNCH_DELAY_MS = 900

/**
 * Locate the DSH desktop executable that owns this process tree.
 *
 * A packaged Desktop runs `DeepSeek Harness.exe` as the main process, and
 * `process.execPath` inside the Host child is that same executable. When the
 * profile instead runs under a plain Node binary (a development or headless
 * boot) relaunching would start the wrong program, so the caller refuses rather
 * than launching a stray Node process.
 *
 * @returns the executable path and the directory to start it in, or a reason
 *   this instance cannot restart itself.
 */
function resolveTarget() {
  const exe = process.execPath
  if (typeof exe !== 'string' || exe.length === 0) {
    return { error: 'Cannot determine the DSH executable path.' }
  }
  if (!existsSync(exe)) return { error: `The DSH executable is missing: ${exe}` }

  // A packaged Desktop binary sits beside `resources/app.asar`; a browser-only
  // (`dsh web`) or development run does not, and has no window to relaunch.
  const resourcesDir = resolve(dirname(exe), 'resources')
  if (!existsSync(join(resourcesDir, 'app.asar'))) {
    return {
      error: 'This DSH instance is not the desktop app, so it cannot be relaunched automatically. Quit it and start it again.',
    }
  }

  // A Node executable here means the Host was booted outside the desktop shell.
  const base = exe.split(/[\\/]/u).pop() ?? ''
  if (/^node(?:\.exe)?$/iu.test(base)) {
    return {
      error: 'This DSH instance was started by Node rather than the desktop app, so it cannot be relaunched automatically.',
    }
  }

  return { exe, cwd: dirname(exe) }
}

/**
 * Whether a process with this pid currently exists.
 * @param pid - the pid to probe.
 * @returns true while the process exists.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

/**
 * Read the Electron main process pid.
 *
 * In the Desktop the Host runs as an Electron utility process whose parent is
 * the browser (main) process, so this value is that pid.
 *
 * @returns the pid, or undefined when it does not look like a live parent.
 */
function mainProcessPid() {
  const ppid = process.ppid
  if (typeof ppid !== 'number' || !Number.isSafeInteger(ppid) || ppid <= 1) return undefined
  return isAlive(ppid) ? ppid : undefined
}

/**
 * Start the detached relauncher.
 *
 * @returns the relauncher pid.
 * @throws when the target cannot be relaunched or the spawn fails.
 */
function launchRelauncher() {
  const target = resolveTarget()
  if (target.error !== undefined) throw new Error(target.error)

  const script = join(here, 'restart-host.js')
  if (!existsSync(script)) throw new Error(`The relauncher script is missing: ${script}`)

  const mainPid = mainProcessPid()
  if (mainPid === undefined) {
    throw new Error('Cannot find the DSH main process to quit, so the restart cannot be completed.')
  }

  // `spawn` passes this array straight to the child, so a path containing
  // spaces needs no quoting here.
  const child = spawn(
    process.execPath,
    [
      script,
      '--quit-pid', String(mainPid),
      '--host-pid', String(process.pid),
      '--exe', target.exe,
      '--cwd', target.cwd,
      '--delay-ms', String(RELAUNCH_DELAY_MS),
    ],
    {
      // Leaving this process group is what lets it outlive the app.
      detached: true,
      stdio: 'ignore',
      cwd: target.cwd,
      // `process.execPath` is the Electron binary; without this flag the
      // relauncher would start a second copy of the GUI instead of running a
      // script.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  )
  child.unref()

  if (child.pid === undefined) throw new Error('The restart helper did not start.')
  return child.pid
}

/**
 * Answer one request with a JSON body.
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function reply(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Mount the bundle.
 *
 * Registers one exact POST route. The Client half calls it; the body's `action`
 * selects "tell me whether restart is possible" or "start the restart".
 *
 * @param ctx - the profile context owning this row.
 */
export function apply(ctx) {
  /** The relauncher started by this row, so a second press cannot queue another. */
  let restartingPid

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        reply(res, 405, { ok: false, error: 'Use POST.' })
        return
      }

      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        // The body is one small JSON object; cap it so a stray client cannot
        // grow this process's memory.
        if (raw.length < 8192) raw += chunk
      })
      req.on('end', () => {
        let action = 'capability'
        try {
          const parsed = raw.length === 0 ? {} : JSON.parse(raw)
          if (typeof parsed?.action === 'string') action = parsed.action
        } catch {
          reply(res, 400, { ok: false, error: 'The request body must be JSON.' })
          return
        }

        if (action === 'capability') {
          const target = resolveTarget()
          if (target.error !== undefined) {
            reply(res, 200, { ok: true, supported: false, reason: target.error })
            return
          }
          if (mainProcessPid() === undefined) {
            reply(res, 200, {
              ok: true,
              supported: false,
              reason: 'Cannot find the DSH main process to quit.',
            })
            return
          }
          reply(res, 200, { ok: true, supported: true })
          return
        }

        if (action === 'restart') {
          try {
            restartingPid ??= launchRelauncher()
            reply(res, 200, { ok: true, pid: restartingPid })
          } catch (error) {
            reply(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          return
        }

        reply(res, 400, { ok: false, error: `Unknown action: ${action}` })
      })
      req.on('error', () => {
        try {
          res.destroy()
        } catch {
          // The socket is already gone.
        }
      })
    },
  }), 'dsh-restart: route')
}
