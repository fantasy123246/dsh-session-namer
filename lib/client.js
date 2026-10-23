// Registered as a window.__ModuleLoader__ module, like every other profile
// bundle client half. There is no build step: the only require-able module is
// `react`, and everything else is plain ES5-ish React.createElement.
window.__ModuleLoader__.load({
  id: 'dsh-session-namer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const NS = 'dsh-session-namer'

    const R = {
      status: '/dsh-session-namer/status',
      refresh: '/dsh-session-namer/refresh',
    }

    /**
     * Call one of this plugin's same-origin routes.
     * @param path - route path.
     * @param payload - when defined, POST this JSON body; otherwise GET.
     * @returns the decoded response body.
     */
    async function api(path, payload) {
      const init = payload === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      let res
      try {
        res = await fetch(path, init)
      } catch (err) {
        throw new Error('无法连接到 DSH 主机：' + (err && err.message ? err.message : String(err)))
      }
      let data = null
      try {
        data = await res.json()
      } catch (err) {
        data = null
      }
      if (data === null) throw new Error('请求失败（HTTP ' + res.status + '）')
      if (data.error) throw new Error(data.error)
      return data
    }

    const listeners = new Set()
    let openSessionId = null
    const subscribe = (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }
    const getOpenSession = () => openSessionId
    function setOpen(sessionId, open) {
      openSessionId = open ? sessionId : null
      listeners.forEach((fn) => fn())
    }
    function useOpenSession() {
      return React.useSyncExternalStore(subscribe, getOpenSession, () => null)
    }

    function SparkIcon() {
      return React.createElement('svg', {
        className: 'dsn-icon',
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
      },
        React.createElement('path', {
          d: 'M8 1.2 9.5 6 14.3 7.4 9.5 8.9 8 13.7 6.5 8.9 1.7 7.4 6.5 6Z',
          fill: 'currentColor',
        }))
    }

    /**
     * Header action: regenerate the title of the open conversation.
     *
     * It sits in the conversation header rather than the sidebar row menu on
     * purpose — the sidebar lists every session including ones that were closed
     * long ago, and this plugin must never rewrite a pre-existing name. The
     * header only ever acts on the session the user has open.
     *
     * @param props - slot props; `sessionId` identifies the open conversation.
     */
    function HeaderAction(props) {
      const sessionId = props.sessionId
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const timer = React.useRef(null)

      React.useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current)
      }, [])

      const flash = (value) => {
        setNote(value)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          setNote(null)
          timer.current = null
        }, 4200)
      }

      const run = () => {
        if (busy || sessionId === undefined) return
        setBusy(true)
        setNote(null)
        api(R.refresh, { sessionId })
          .then((data) => {
            if (data && data.changed && data.title) flash('已改名为「' + data.title + '」')
            else if (data && data.title) flash('名字已经够好：「' + data.title + '」')
            else flash('已完成，但没有得到新标题')
          })
          .catch((err) => flash('失败：' + (err && err.message ? err.message : String(err))))
          .then(() => setBusy(false))
      }

      const label = busy ? '取名中…' : '重新取名'

      return React.createElement('span', { className: 'dsn-wrap' },
        React.createElement('button', {
          type: 'button',
          className: 'dsn-trigger' + (busy ? ' dsn-busy' : ''),
          title: '用这段对话重新生成会话名（只改当前会话）',
          'aria-label': '重新生成会话名',
          disabled: busy,
          onClick: run,
        },
          React.createElement(SparkIcon, null),
          React.createElement('span', { className: 'dsn-trigger-label' }, label)),
        note !== null && React.createElement('span', { className: 'dsn-note' }, note))
    }

    const STYLES = `
.dsn-wrap { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.dsn-icon { width: 13px; height: 13px; display: block; flex: none; }
.dsn-trigger, .dsn-note { --dsn-accent: #4d6bfe; }
.dsn-trigger {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px 0 8px;
  border-radius: 13px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  background: transparent; color: var(--dsw-alias-label-secondary, #888);
  font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap;
}
.dsn-trigger:hover { color: var(--dsn-accent); border-color: var(--dsn-accent); }
.dsn-trigger:disabled { cursor: progress; opacity: .65; }
.dsn-trigger.dsn-busy { opacity: .8; }
.dsn-trigger.dsn-busy .dsn-icon { animation: dsn-spin 1.4s linear infinite; }
.dsn-note {
  font-size: 12px; color: var(--dsw-alias-label-secondary, #888);
  max-width: 42ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
@keyframes dsn-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
/* Some themes restyle buttons inside the composer and header, so the same
   declarations are repeated with !important. */
.dsn-trigger {
  display: inline-flex !important; align-items: center !important; gap: 6px !important;
  height: 26px !important; padding: 0 10px 0 8px !important; border-radius: 13px !important;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)) !important;
  background: transparent !important; color: var(--dsw-alias-label-secondary, #888) !important;
  font-size: 12px !important; line-height: 1 !important;
}
.dsn-trigger:hover { color: var(--dsn-accent) !important; border-color: var(--dsn-accent) !important; }
`

    /**
     * Client plugin body.
     * @param ctx - client root context carrying the slot registry.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-plugin', NS)
        tag.textContent = STYLES
        document.head.appendChild(tag)
        return () => {
          if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
        }
      }, NS + ': styles')

      ctx.slots.inject('conversation.session.header.actions', () => {
        return ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'session-namer',
          order: 250,
          label: () => '重新取名',
        }, (props) => React.createElement(HeaderAction, props))
      })
    }

    module.exports = { name: NS, inject: ['slots'], apply }
    return module.exports
  },
})
