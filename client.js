/**
 * dsh-reasoning-picker —— 浏览器端（client half）
 *
 * 在输入框右侧（conversation.input.right）注册一个小按钮：
 *  - 点按钮 → 读取当前草稿 → POST /reasoning-picker/evaluate → 浮窗显示推荐
 *    （Flash/Pro · 等级 · 一行理由）与「应用」按钮。
 *  - 点「应用」→ POST /reasoning-picker/apply → 把推荐写进当前会话模型选择。
 * 绝不自动发消息；草稿原样保留。
 */
window.__ModuleLoader__.load({
  id: 'dsh-reasoning-picker',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var ReactDOM = require('react-dom')

    var EVALUATE_ENDPOINT = '/reasoning-picker/evaluate'
    var APPLY_ENDPOINT = '/reasoning-picker/apply'
    var STYLE_ID = 'dsh-reasoning-picker-style'

    /* ------------------------------------------------------------ 共享状态 */

    var listeners = new Set()
    var state = null

    function notify() {
      listeners.forEach(function (fn) {
        try {
          fn()
        } catch (e) {}
      })
    }
    function subscribe(fn) {
      listeners.add(fn)
      return function () {
        listeners.delete(fn)
      }
    }
    function getState() {
      return state
    }
    function setState(next) {
      state = next
      notify()
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok || !json || json.ok !== true) {
            var err = json && json.error ? json.error.message || json.error.code : 'HTTP ' + res.status
            throw new Error(err)
          }
          return json.value
        })
      })
    }

    /* ---------------------------------------------------------- 组件 */

    function PickerButton(props) {
      var sessionId = props.sessionId
      var useInput = props.useInput
      var draft = useInput(function (s) {
        return s && typeof s.draft === 'string' ? s.draft : ''
      })

      var snap = React.useSyncExternalStore(subscribe, getState, getState)
      var owned = snap && (!snap.sessionId || snap.sessionId === sessionId) ? snap : null
      var busy = !!(owned && owned.phase === 'loading')

      var start = React.useCallback(
        function () {
          if (busy) return
          if (!draft || !draft.trim()) {
            setState({ phase: 'error', sessionId: sessionId, message: '输入框是空的' })
            return
          }
          setState({ phase: 'loading', sessionId: sessionId, draft: draft })
          postJson(EVALUATE_ENDPOINT, { sessionId: sessionId, text: draft })
            .then(function (value) {
              setState({ phase: 'result', sessionId: sessionId, draft: draft, value: value })
            })
            .catch(function (e) {
              setState({ phase: 'error', sessionId: sessionId, draft: draft, message: String(e && e.message ? e.message : e) })
            })
        },
        [busy, draft, sessionId],
      )

      var applyNow = React.useCallback(
        function () {
          if (!owned || owned.phase !== 'result' || !owned.value) return
          var v = owned.value
          postJson(APPLY_ENDPOINT, {
            sessionId: sessionId,
            provider: v.provider,
            model: v.model,
            reasoningEffort: v.reasoningEffort,
          })
            .then(function () {
              setState({ phase: 'applied', sessionId: sessionId, value: v })
              // 应用成功后 1.5 秒自动收起提示框，免去手动关闭
              setTimeout(function () {
                var cur = getState()
                if (cur && cur.phase === 'applied' && cur.value === v) setState(null)
              }, 1500)
            })
            .catch(function (e) {
              setState({ phase: 'error', sessionId: sessionId, message: String(e && e.message ? e.message : e) })
            })
        },
        [owned, sessionId],
      )

      var close = React.useCallback(function () {
        setState(null)
      }, [])

      var button = React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-rp-btn',
          title: '估算任务应采用的模型与推理等级',
          'aria-label': '估算推理等级',
          'aria-disabled': busy ? true : undefined,
          onClick: start,
        },
        React.createElement('span', { 'aria-hidden': true }, busy ? '◌' : '📊'),
      )

      if (!owned) return button

      var lines = []
      if (owned.phase === 'loading') {
        lines.push(React.createElement('div', { key: 'l', className: 'dsh-rp-status' }, '评估中…'))
      } else if (owned.phase === 'error') {
        lines.push(React.createElement('div', { key: 'e', className: 'dsh-rp-status dsh-rp-err' }, owned.message || '评估失败'))
        lines.push(
          React.createElement(
            'div',
            { key: 'a', className: 'dsh-rp-actions' },
            React.createElement('button', { type: 'button', className: 'dsh-rp-btn2', onClick: start }, '重试'),
            React.createElement('button', { type: 'button', className: 'dsh-rp-btn2', onClick: close }, '关闭'),
          ),
        )
      } else if (owned.phase === 'applied') {
        var av = owned.value || {}
        lines.push(
          React.createElement(
            'div',
            { key: 'ok', className: 'dsh-rp-status dsh-rp-ok' },
            '已应用：' + (av.tierLabel || av.tier || '') + ' · ' + (av.reasoningEffort || ''),
          ),
        )
      } else if (owned.phase === 'result') {
        var v = owned.value || {}
        lines.push(
          React.createElement(
            'div',
            { key: 't', className: 'dsh-rp-head' },
            React.createElement('span', { className: 'dsh-rp-tier dsh-rp-tier-' + String(v.tier) }, v.tierLabel || v.tier),
            React.createElement('span', { className: 'dsh-rp-effort' }, ' · ' + String(v.reasoningEffort || '')),
          ),
        )
        if (v.reason) lines.push(React.createElement('div', { key: 'r', className: 'dsh-rp-reason' }, v.reason))
        lines.push(
          React.createElement(
            'div',
            { key: 'a', className: 'dsh-rp-actions' },
            React.createElement('button', { type: 'button', className: 'dsh-rp-apply', onClick: applyNow }, '应用'),
            React.createElement('button', { type: 'button', className: 'dsh-rp-btn2', onClick: close }, '关闭'),
          ),
        )
      }

      var panel = React.createElement('div', { className: 'dsh-rp-panel' }, lines)
      return React.createElement(React.Fragment, null, button, ReactDOM.createPortal(panel, document.body))
    }

    /* ---------------------------------------------------------- 样式 */

    var CSS = [
      '.dsh-rp-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;border:none;background:transparent;cursor:pointer;font-size:15px;line-height:1;color:inherit;padding:0;opacity:.72;transition:opacity .15s,background .15s}',
      '.dsh-rp-btn:hover{opacity:1;background:var(--dsw-alias-bg-hover,rgba(255,255,255,.08))}',
      '.dsh-rp-btn[aria-disabled="true"]{opacity:.45;cursor:default}',
      '.dsh-rp-panel{position:fixed;right:20px;bottom:96px;z-index:9999;min-width:220px;max-width:320px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-elevated,#1e1e1e);color:var(--dsw-alias-text,#eee);border:1px solid var(--dsw-alias-border,#3a3a3a);box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:13px;line-height:1.5}',
      '.dsh-rp-status{color:var(--dsw-alias-text-secondary,#bbb)}',
      '.dsh-rp-err{color:var(--dsw-alias-danger,#ff6b6b)}',
      '.dsh-rp-ok{color:var(--dsw-alias-success,#4ecb71)}',
      '.dsh-rp-head{font-size:15px;font-weight:600}',
      '.dsh-rp-tier-flash{color:var(--dsw-alias-accent,#7aa2ff)}',
      '.dsh-rp-tier-pro{color:var(--dsw-alias-warning,#f5a623)}',
      '.dsh-rp-effort{color:var(--dsw-alias-text-secondary,#aaa);font-weight:400}',
      '.dsh-rp-reason{margin-top:4px;color:var(--dsw-alias-text-secondary,#bbb);font-size:12px}',
      '.dsh-rp-actions{margin-top:8px;display:flex;gap:8px;justify-content:flex-end}',
      '.dsh-rp-apply{padding:3px 12px;border-radius:6px;border:1px solid var(--dsw-alias-accent,#7aa2ff);background:var(--dsw-alias-accent,#7aa2ff);color:#fff;cursor:pointer;font-size:12px}',
      '.dsh-rp-btn2{padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border,#3a3a3a);background:transparent;color:inherit;cursor:pointer;font-size:12px}',
    ].join('\n')

    function ensureStyles() {
      try {
        if (document.getElementById(STYLE_ID)) return
        var el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = CSS
        document.head.appendChild(el)
      } catch (e) {}
    }

    /* ---------------------------------------------------------- 安装 */

    exports.inject = []

    exports.apply = function apply(ctx) {
      ensureStyles()

      ctx.inject(['slots'], function (slotsCtx) {
        var slots = slotsCtx.slots
        if (!slots) return
        return slots.inject('conversation.input.right', function () {
          try {
            return slots.register(
              { name: 'conversation.input.right', id: 'reasoning-picker', order: 61, locale: 'reasoning-picker' },
              PickerButton,
            )
          } catch (e) {
            try {
              console.warn('[reasoning-picker] slot registration failed', e)
            } catch (_) {}
            return function () {}
          }
        })
      })
    }

    return module.exports
  },
})
