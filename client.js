window.__ModuleLoader__.load({
  id: 'dsh-plugin-restart-btn',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /**
     * DSH's own tooltip primitive, when the page's module table provides it.
     *
     * The shipped sidebar row wraps its account trigger in this same primitive,
     * so reusing it keeps the hover card here identical to the rest of the
     * shell instead of the native Windows tooltip. The lookup is guarded: if a
     * future build stops seeding the package the button keeps working and falls
     * back to a `title` attribute.
     */
    const Tooltip = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives').Tooltip ?? null
      } catch {
        return null
      }
    })()

    /**
     * Text this plugin renders.
     *
     * The strings are literal rather than read from the locale service: this
     * bundle declares only `slots` as a dependency, so any other service
     * (`ctx.locale`) may be absent when `apply` runs, and touching it there
     * throws — which fails the entry and aborts the whole page boot.
     */
    const ZH = {
      restart: '重启 DeepSeek Harness',
      restarting: '正在重启 DeepSeek Harness…',
      unavailable: '当前 DSH 实例无法自动重启。',
      confirmTitle: '重启 DeepSeek Harness？',
      confirmBody: '应用将完全退出并自动重新打开。正在进行的任务会被中断。',
      confirm: '确定',
      cancel: '取消',
    }

    const EN = {
      restart: 'Restart DeepSeek Harness',
      restarting: 'Restarting DeepSeek Harness…',
      unavailable: 'This DSH instance cannot restart itself.',
      confirmTitle: 'Restart DeepSeek Harness?',
      confirmBody: 'The app will close completely and reopen automatically. Running tasks will be interrupted.',
      confirm: 'OK',
      cancel: 'Cancel',
    }

    /**
     * Pick the copy for the page's language.
     * @returns the dictionary for the active language.
     */
    function copy() {
      const lang = globalThis.document?.documentElement?.lang ?? globalThis.navigator?.language ?? 'en'
      return String(lang).toLowerCase().startsWith('zh') ? ZH : EN
    }

    /**
     * Styles for the footer button and its confirmation dialog.
     *
     * Copied from the shipped `sidebar.footer.action` occupant (the Cordis panel
     * button) so this control is indistinguishable from it. Three details matter
     * and are easy to get wrong:
     *
     *  - the shipped DOM is `layer > footerButtons > badge`; the `footerButtons`
     *    row is what aligns the icon, so a two-level tree shifts the label;
     *  - in the collapsed rail the owner sets `.footerActions` to
     *    `width:auto; justify-content:center`, so this entry must be exactly
     *    36px wide there or it will not sit on the same centre line;
     *  - the hover fill is `--dsw-alias-interactive-bg-hover`, not a layer token.
     *
     * Sizes and colours below are the shipped values; only the class prefix
     * differs.
     */
    const css = `
/* Outer box: 42px tall with an 8px top gap when the sidebar is wide. */
.dsh-restart-layer {
  flex: none;
  align-items: center;
  width: 100%;
  height: 42px;
  margin: 8px 0 0;
  display: flex;
  position: relative;
}

/* Collapsed rail: the outer box becomes the 36px circular target itself. */
.dsh-restart-layer.dsh-restart-rail {
  width: 36px;
  height: 36px;
  margin: 0;
}

.dsh-restart-footer-buttons {
  align-items: center;
  width: 100%;
  display: flex;
}

.dsh-restart-btn {
  width: calc(100% + 4px);
  height: 42px;
  margin: 0 -2px;
  padding: 0 10px 0 8px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--dsw-alias-label-primary);
  background: 0 0;
  border: none;
  border-radius: 12px;
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  overflow: hidden;
}

.dsh-restart-btn:hover,
.dsh-restart-btn[data-active] {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dsh-restart-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: -2px;
}

.dsh-restart-rail .dsh-restart-footer-buttons {
  flex-direction: column;
  gap: 2px;
}

.dsh-restart-rail .dsh-restart-btn {
  corner-shape: round;
  border-radius: 50%;
  justify-content: center;
  gap: 0;
  width: 36px;
  height: 36px;
  padding: 0;
}

.dsh-restart-btn[disabled] {
  opacity: 0.55;
  cursor: default;
}

.dsh-restart-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-restart-btn[data-busy="true"] .dsh-restart-icon {
  animation: dsh-restart-spin 900ms linear infinite;
}

@keyframes dsh-restart-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/*
 * Inline variant: rendered into the footer's account row, beside the chip.
 * That row is a flex line with an 8px gap and centered items, so the button
 * only has to be its own square and push itself to the right edge.
 */
.dsh-restart-inline {
  margin-left: auto;
  display: flex;
  align-items: center;
}

.dsh-restart-inline .dsh-restart-btn {
  justify-content: center;
  gap: 0;
  width: 30px;
  height: 30px;
  margin: 0;
  padding: 0;
  border-radius: 9px;
}

/* ---- confirmation dialog ---- */

.dsh-restart-scrim {
  position: fixed;
  inset: 0;
  z-index: 2147483100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.32);
}

.dsh-restart-dialog {
  width: 360px;
  max-width: calc(100vw - 32px);
  padding: 18px 18px 14px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
  color: var(--dsw-alias-label-primary);
}

.dsh-restart-dialog-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
}

.dsh-restart-dialog-body {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-restart-dialog-error {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}

.dsh-restart-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dsh-restart-action {
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid transparent;
}

/* Cancel: quiet outline, the default focus target. */
.dsh-restart-action[data-variant="secondary"] {
  background: 0 0;
  border-color: var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary);
}

.dsh-restart-action[data-variant="secondary"]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

/*
 * Confirm: a solid, high-contrast fill.
 *
 * label-primary is the app's strongest text colour %?near-black on the light
 * palette and near-white on the dark one %?so filling with it and writing the
 * label in bg-base yields a black button in light mode and an inverted one in
 * dark mode without hard-coding either scheme. The app exposes no
 * data-color-scheme attribute to branch on, so a token pair is the reliable way
 * to stay legible in both palettes.
 */
.dsh-restart-action[data-variant="primary"] {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-base);
  border-color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

.dsh-restart-action[data-variant="primary"]:hover {
  opacity: 0.88;
}

.dsh-restart-action[data-variant="primary"]:disabled {
  opacity: 0.5;
  cursor: default;
}

.dsh-restart-action:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
`

    /**
     * A power symbol: a ring broken by a gap at the top, with a stem rising
     * through that gap. Drawn inline so the plugin needs no icon package, and
     * stroked with `currentColor` so it follows both palettes.
     *
     * The shipped footer button asks its icon component for size 16 when the
     * sidebar is wide and 18 in the collapsed rail; matching that keeps the
     * glyph weight identical in both states. The geometry is kept in one
     * 24-unit box and shared with `icon.svg`, so the package icon and the
     * button glyph cannot drift apart.
     *
     * @param props - the glyph size in pixels.
     * @returns the icon markup.
     */
    function RestartIcon({ size }) {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, fill: 'none' },
        // Ring: radius 8 around (12, 12), gap of 62° centred on the top.
        h('path', {
          d: 'M16.12 5.14A8 8 0 1 1 7.88 5.14',
          stroke: 'currentColor',
          strokeWidth: '2.66',
          strokeLinecap: 'round',
        }),
        // Stem: same weight as the ring, running from above the ring down to
        // just short of its centre.
        h('path', {
          d: 'M12 2.81V10.89',
          stroke: 'currentColor',
          strokeWidth: '2.66',
          strokeLinecap: 'round',
        }),
      )
    }

    /** Exact path the Host half serves (mirrors `ROUTE_PATH` in index.js). */
    const ROUTE_PATH = '/plugins-local/dsh-restart'

    /**
     * Call the Host half over its private route.
     *
     * A normal bundle cannot use `host.call` (that verb belongs to sandboxed
     * dynamic packages), so the Host exposes one plain HTTP route instead. It is
     * same-origin, so the page's own session cookie authorizes the request.
     *
     * @param action - "capability" or "restart".
     * @returns the parsed reply.
     */
    async function callHost(action) {
      const response = await fetch(ROUTE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!response.ok) throw new Error(`The restart service answered ${String(response.status)}.`)
      return response.json()
    }

    /**
     * The confirmation dialog, rendered over the page.
     *
     * A restart closes every window, so it is treated like a destructive action:
     * it asks first, focuses Cancel on open so a stray Enter cannot confirm it,
     * and closes on Escape or a click outside.
     *
     * @param props - copy, busy state, an optional failure, and the two handlers.
     * @returns the dialog markup.
     */
    function ConfirmDialog({ t, busy, error, onConfirm, onCancel }) {
      const confirmRef = React.useRef(null)
      const cancelRef = React.useRef(null)

      // Focus Cancel, the safe choice, the moment the dialog appears.
      React.useEffect(() => {
        cancelRef.current?.focus()
      }, [])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation()
            onCancel()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
        }
      }, [busy, onCancel])

      return h(
        'div',
        {
          className: 'dsh-restart-scrim',
          role: 'presentation',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel()
          },
        },
        h(
          'div',
          {
            className: 'dsh-restart-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-restart-title',
            'aria-describedby': 'dsh-restart-body',
          },
          h('h2', { id: 'dsh-restart-title', className: 'dsh-restart-dialog-title' }, t.confirmTitle),
          h('p', { id: 'dsh-restart-body', className: 'dsh-restart-dialog-body' }, t.confirmBody),
          error === null
            ? null
            : h('p', { className: 'dsh-restart-dialog-error', role: 'alert' }, error),
          h(
            'div',
            { className: 'dsh-restart-actions' },
            h(
              'button',
              {
                ref: cancelRef,
                type: 'button',
                className: 'dsh-restart-action',
                'data-variant': 'secondary',
                disabled: busy,
                onClick: onCancel,
              },
              t.cancel,
            ),
            h(
              'button',
              {
                ref: confirmRef,
                type: 'button',
                className: 'dsh-restart-action',
                'data-variant': 'primary',
                disabled: busy,
                onClick: onConfirm,
              },
              busy ? t.restarting : t.confirm,
            ),
          ),
        ),
      )
    }

    /** The live anchor of the footer row that holds the account chip. */
    const ROW_ANCHOR = '[data-slot="settings.launcher"]'

    /**
     * The sidebar row that holds the account chip.
     *
     * The shipped settings area renders `div.triggerRow > (launcher slot,
     * connection dot, update dot)` and offers no additive slot inside that row,
     * so a normal sibling entry cannot sit beside the chip. The slot anchor
     * itself is `display: contents`, which makes its parent element the flex
     * row, so a portal into that element lines the button up with the chip
     * without touching the owner's layout.
     *
     * The row is looked up after mount (and again when the sidebar changes
     * width) because this entry and the settings area race during boot.
     *
     * @param active - whether the sidebar is wide enough for an inline button.
     * @returns the row element, or null while it is not there.
     */
    function useSettingsRow(active) {
      const [row, setRow] = React.useState(null)

      React.useEffect(() => {
        if (!active) {
          setRow(null)
          return undefined
        }
        let settled = false
        const resolve = () => {
          const anchor = document.querySelector(ROW_ANCHOR)
          const parent = anchor?.parentElement ?? null
          if (!(parent instanceof HTMLElement)) return
          settled = true
          setRow(parent)
        }
        resolve()
        // The settings area may mount after this entry; watch until it is there,
        // then stop watching so the observer cannot cost anything at runtime.
        const observer = new MutationObserver(() => {
          if (!settled) resolve()
        })
        observer.observe(document.body, { childList: true, subtree: true })
        const timer = window.setTimeout(() => observer.disconnect(), 5000)
        return () => {
          observer.disconnect()
          window.clearTimeout(timer)
        }
      }, [active])

      return row
    }

    /**
     * The sidebar-foot Restart action.
     *
     * Registers into the additive `sidebar.footer.action` list, so the shipped
     * entries beside it stay untouched. Only `wide` arrives from the slot owner.
     * When the sidebar is wide the button is portalled into the account row and
     * only the confirmation dialog stays at the slot position; in the collapsed
     * rail the whole control stays in the slot, where it is the 36px target.
     *
     * @param props - the sidebar column state.
     * @returns the footer button plus its confirmation dialog.
     */
    function RestartAction(props) {
      const wide = props.wide === true
      const t = copy()
      const [asking, setAsking] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      /** Set once the Host accepted the restart, so the UI can stay locked. */
      const [started, setStarted] = React.useState(false)

      /**
       * Release the lock if the app is still here a while after the Host
       * accepted the request.
       *
       * A successful restart tears this page down, so the timer never fires.
       * If the relauncher failed after acknowledging  or the app refused to
       * die  the user is left looking at a permanently disabled dialog with no
       * way out, so the button becomes usable again instead.
       */
      React.useEffect(() => {
        if (!started) return undefined
        const timer = window.setTimeout(() => {
          setStarted(false)
          setBusy(false)
          setError(t.unavailable)
        }, 20000)
        return () => {
          window.clearTimeout(timer)
        }
      }, [started, t])

      /** Close the dialog, ignoring a close request while the restart runs. */
      const dismiss = React.useCallback(() => {
        if (busy) return
        setAsking(false)
        setError(null)
      }, [busy])

      /** Ask the Host to start the restart, then leave the dialog disabled. */
      const confirm = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          const capability = await callHost('capability')
          if (capability?.supported !== true) {
            setError(capability?.reason ?? t.unavailable)
            setBusy(false)
            return
          }
          const accepted = await callHost('restart')
          if (accepted?.ok !== true) {
            setError(accepted?.error ?? t.unavailable)
            setBusy(false)
            return
          }
          // The app is shutting down: stay disabled so a second press cannot
          // queue another relauncher. `started` is released by the effect above
          // if the app never actually goes away.
          setStarted(true)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setBusy(false)
        }
      }

      const row = useSettingsRow(wide)
      const label = busy ? t.restarting : t.restart

      const trigger = (...children) => {
        const button = h(
          'button',
          {
            type: 'button',
            className: 'dsh-restart-btn',
            'data-busy': busy,
            disabled: busy,
            // With the shell tooltip in place a native `title` would stack a
            // second, differently styled hover card on top of it.
            title: Tooltip === null ? label : undefined,
            'aria-label': label,
            onClick: () => {
              setError(null)
              setAsking(true)
            },
          },
          ...children,
        )
        return Tooltip === null ? button : h(Tooltip, { label }, button)
      }

      const dialog = asking
        ? h(ConfirmDialog, {
            t,
            busy,
            error,
            onConfirm: () => {
              confirm().catch(() => void 0)
            },
            onCancel: dismiss,
          })
        : null

      // Beside the account chip: the row already owns the 8px gap and the
      // vertical centring, so the button only adds its own square wrapper.
      if (wide && row !== null) {
        return h(
          React.Fragment,
          null,
          ReactDOM.createPortal(
            h('span', { className: 'dsh-restart-inline' }, trigger(h(RestartIcon, { size: 16 }))),
            row,
          ),
          dialog,
        )
      }

      // Mirrors the shipped footer button's DOM exactly:
      //   div.layer (+ .rail) > div.footerButtons > button.badge
      // The `footerButtons` row is what centres the icon in the rail, so
      // omitting it shifts the label and breaks left alignment. This branch also
      // covers a wide sidebar whose account row has not mounted yet, so the
      // button never disappears while the row is being looked up.
      return h(
        'div',
        { className: wide ? 'dsh-restart-layer' : 'dsh-restart-layer dsh-restart-rail' },
        h(
          'div',
          { className: 'dsh-restart-footer-buttons' },
          trigger(
            h(RestartIcon, { size: wide ? 16 : 18 }),
            wide ? h('span', { className: 'dsh-restart-label' }, label) : null,
          ),
        ),
        dialog,
      )
    }

    /**
     * Insert this bundle's stylesheet into the document.
     *
     * A plain bundle runs in the page itself, where the `styles` sandbox helper
     * does not exist (`styles` belongs to sandboxed dynamic packages), so this
     * creates a `<style>` element directly, as the shipped bundles do.
     *
     * @returns a disposer that removes the element.
     */
    function insertStyles() {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-restart-btn'
      tag.textContent = css
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    return {
      // `slots` is the only service touched. Reading any other service here
      // (`ctx.locale`, for example) throws when it is absent, and a throwing
      // `apply` marks this entry failed %?which aborts the entire page boot.
      inject: ['slots'],
      apply(ctx) {
        const disposeStyles = insertStyles()
        ctx.effect(() => () => disposeStyles())

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-restart',
              order: 90,
            },
            RestartAction,
          ),
        )
      },
    }
  },
})
