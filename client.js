/**
 * Settings-page client module (hand-written lazy CommonJS, no build step).
 *
 * Three hard contracts:
 *   1. package.json declares `dsh.client` and `exports["./client"]`;
 *   2. registration goes through `window.__ModuleLoader__.load({ id, factory })`
 *      and `id` must equal the package name;
 *   3. `react` comes from the shell's frozen module table — no React install,
 *      no CDN, no bundler.
 *
 * Configuration reads and writes go through the host `/memory-ui` route. When
 * the host is not running, use `scripts/config-ui.mjs` instead.
 */
window.__ModuleLoader__.load({
  id: 'dsh-temporal-memory',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    var STYLE_ID = 'dsh-temporal-memory-settings-style'
    if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.tm-wrap{display:flex;flex-direction:column;gap:16px;font-size:13px;color:var(--dsw-alias-label-primary,#1c2128);}',
        '.tm-card{border:1px solid var(--dsw-alias-border-l1,#d9dee5);border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-base,#fff);}',
        '.tm-card h3{margin:0 0 10px;font-size:14px;}',
        '.tm-paths{display:grid;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6572);word-break:break-all;}',
        '.tm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px 16px;}',
        '.tm-field{display:flex;flex-direction:column;gap:4px;min-width:0;}',
        '.tm-field label{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6572);}',
        '.tm-help{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border:1px solid var(--dsw-alias-border-l1,#d9dee5);border-radius:50%;font-size:10px;cursor:help;}',
        '.tm-field input[type=text],.tm-field input[type=number],.tm-field select{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,#d9dee5);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;}',
        '.tm-check{display:flex;align-items:center;gap:7px;padding:5px 0;}',
        '.tm-src{align-self:flex-start;font-size:11px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,#d9dee5);border-radius:999px;color:var(--dsw-alias-label-secondary,#5b6572);}',
        '.tm-src-patch{color:#b45309;border-color:#b45309;}',
        '.tm-override{font-size:11px;color:#b45309;}',
        '.tm-risk{font-size:11px;color:#b45309;}',
        '.tm-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
        '.tm-btn{padding:6px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d9dee5);background:var(--dsw-alias-state-business-primary,#2563eb);color:#fff;font:inherit;cursor:pointer;}',
        '.tm-btn.secondary{background:transparent;color:inherit;}',
        '.tm-btn:disabled{opacity:.55;cursor:default;}',
        '.tm-status{font-size:12px;}',
        '.tm-ok{color:#15803d;}.tm-warn{color:#b45309;}.tm-err{color:#b91c1c;}',
        '.tm-muted{font-size:12px;color:var(--dsw-alias-label-secondary,#5b6572);}',
      ].join('')
      document.head.appendChild(style)
    }

    // The settings page exposes 16 fields. `ui.host` / `ui.port` are superseded
    // by the host UI and hidden here; journal.* is deliberately not configurable —
    // the journal is written by the host's scheduled task and only read by the
    // plugin. The keys stay in lib/config.js's known set so an old config.json
    // does not produce "unknown key" warnings.
    var FIELDS = [
      { key: 'timeZone', label: '时区', type: 'text', placeholder: 'Asia/Shanghai', tip: '决定"今天""昨天"怎么算，也决定每天的日记按哪个时区切分。人在国内不用改。默认 Asia/Shanghai。' },
      { key: 'namespace', label: '记忆分组', type: 'text', tip: '不同分组之间的记忆互相看不见。只用一台 DSH、一个人用时保持默认即可；要给不同用途分开记才需要改。默认 default。' },
      { key: 'retentionDays', label: '记忆保留天数', type: 'number', min: 1, max: 36500, tip: '多少天以内的记忆还会被翻出来用。超过这天数的旧记忆，在当天已有日记的情况下才清理；没日记覆盖的会保留并提示你。1–36500，默认 365。', risk: '注意：调小会在日记覆盖后清理旧记忆；调大占更多磁盘。' },
      { key: 'entities', label: '常提到的名词（逗号分开）', type: 'text', placeholder: '示例网关, 示例系统', tip: '把你常聊的项目、系统写进来，比如"示例网关, 示例系统"。以后提到它们时更容易翻到相关的旧记忆。可留空。最多 100 项。' },
      { key: 'capture.enabled', label: '自动记录对话', type: 'bool', tip: '关掉后新的对话不再存成记忆，已经存下的不受影响。只想聊天不想留痕时关它。默认开启。' },
      { key: 'capture.maxRecordsPerTurn', label: '一次对话最多记几条', type: 'number', min: 1, max: 50, tip: '一轮对话最多整理出几条记忆。调小更省空间，调大更不容易漏掉重点。1–50，默认 8。' },
      { key: 'inject.enabled', label: '自动提醒相关记忆', type: 'bool', tip: '开启后聊到相关话题时，会把以前记的内容自动带进对话。关掉后不再自动带，但可以随时让 Agent 主动去查。默认开启。' },
      { key: 'inject.maxItems', label: '每次最多提醒几条', type: 'number', min: 1, max: 50, tip: '一次自动提醒最多带几条旧记忆。带太多会占地方、也容易跑题。1–50，默认 6。' },
      { key: 'inject.maxTokens', label: '提醒内容的长度上限', type: 'number', min: 100, max: 8000, tip: '自动提醒的内容最长多长，按字数估算（中文大约 1 个字算 1）。太长会挤掉你正在聊的内容。100–8000，默认 1200。' },
      { key: 'inject.coldStartDays', label: '新对话开头回看几天', type: 'number', min: 0, max: 90, tip: '新开一个对话时，先翻出最近几天的记忆垫底，免得每开新对话都要重新交代背景。填 0 表示不做这件事。0–90，默认 3。' },
      { key: 'inject.coldStartItems', label: '新对话开头最多带几条', type: 'number', min: 1, max: 20, tip: '上面那件事最多带进来几条记忆。1–20，默认 5。' },
      { key: 'inject.cooldownTurns', label: '两次提醒之间隔几轮', type: 'number', min: 0, max: 100, tip: '刚提醒过一次后，至少隔几轮才再提醒，免得刷屏。填 0 表示不限制。0–100，默认 3。' },
      { key: 'compile.minRecords', label: '同一件事记够几条才整理', type: 'number', min: 1, max: 50, tip: '同一个话题攒够几条记录后，才自动整理成一页笔记。调大能减少零碎笔记。1–50，默认 2。' },
      { key: 'compile.maxTopics', label: '一次最多整理几个话题', type: 'number', min: 1, max: 500, tip: '一次自动整理最多处理几个话题，防止跑太久卡住。1–500，默认 20。' },
      { key: 'privacy.enhanced', label: '更严格的隐私保护', type: 'bool', tip: '凭据（密钥、密码、令牌、私钥、连接串）在写入前就被替换成「[已脱敏]」，存下来的只有占位符，与开关无关。开关管的是普通内容要不要处理得更严，可能连有用信息一起遮掉。默认关闭。' },
      { key: 'growth.enabled', label: '每月更新 Agent 软画像', type: 'bool', tip: '开启后每月首次启动时，用上月日记与概念页归纳一次表达风格、主动性与提醒方式，写进 profile/agent/personality.md 并每会话注入一次。只调软画像，不改角色设定、安全策略与权限。证据不足保持原状，人工改过该文件后不再覆盖。默认关闭。', risk: '注意：开启后每月会多一份画像文件与一次归纳（只看计数与主题，不读原文）；想完全接管就手改 personality.md，插件会停下。' },
    ]

    // Presentation order only; every key here must also exist in FIELDS.
    var GROUPS = [
      { title: '基本设置', keys: ['timeZone', 'namespace', 'retentionDays', 'entities'] },
      { title: '记录与提醒', keys: ['capture.enabled', 'capture.maxRecordsPerTurn', 'inject.enabled', 'inject.maxItems', 'inject.maxTokens', 'inject.coldStartDays', 'inject.coldStartItems', 'inject.cooldownTurns'] },
      { title: '自动笔记（概念页）', keys: ['compile.minRecords', 'compile.maxTopics'] },
      { title: '隐私与成长', keys: ['privacy.enhanced', 'growth.enabled'] },
    ]

    var FIELD_BY_KEY = {}
    FIELDS.forEach(function (field) { FIELD_BY_KEY[field.key] = field })

    // Dotted-path access keeps the form flat while the config stays nested.
    function getPath(object, key) {
      var node = object
      var parts = key.split('.')
      for (var i = 0; i < parts.length; i++) {
        if (!node || typeof node !== 'object') return undefined
        node = node[parts[i]]
      }
      return node
    }

    function setPath(object, key, value) {
      var parts = key.split('.')
      var node = object
      for (var i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {}
        node = node[parts[i]]
      }
      node[parts[parts.length - 1]] = value
    }

    /**
     * Effective config → form values. Booleans stay booleans so checkboxes can
     * bind directly; entities become a comma-separated string; everything else
     * becomes a controlled-input string.
     */
    function valuesOf(config) {
      var values = {}
      FIELDS.forEach(function (field) {
        var value = getPath(config, field.key)
        if (field.type === 'bool') values[field.key] = value === true
        else if (field.key === 'entities') values[field.key] = Array.isArray(value) ? value.join(', ') : ''
        else values[field.key] = value === undefined || value === null ? '' : String(value)
      })
      return values
    }

    /**
     * Form values → PUT body. Only known FIELDS are sent, so hidden keys are
     * never overwritten. Empty numbers are omitted rather than coerced to 0,
     * and entities accept both ASCII and full-width commas plus whitespace.
     */
    function payloadOf(values) {
      var body = {}
      FIELDS.forEach(function (field) {
        var value = getPath(values, field.key)
        if (field.type === 'bool') {
          setPath(body, field.key, value === true)
          return
        }
        if (field.key === 'entities') {
          setPath(body, field.key, String(value || '').split(/[,，\s]+/).map(function (item) { return item.trim() }).filter(Boolean))
          return
        }
        if (field.type === 'number') {
          if (value === '' || value === undefined || value === null) return
          setPath(body, field.key, Number(value))
          return
        }
        setPath(body, field.key, String(value || '').trim())
      })
      return body
    }

    // Provenance badges: where the effective value came from, in plain language.
    function sourceLabel(source) {
      if (source === 'patch') return '部署固定'
      if (source === 'config.json') return '已保存'
      return '默认值'
    }

    function sourceNote(source) {
      if (source === 'patch') return '这个值由部署配置固定，在这里改不会生效。要改请找维护部署的人。'
      if (source === 'config.json') return '上次从这个页面保存过，改完重启 DSH 生效。'
      return '没改过，用插件自带的默认值。'
    }

    function rootLabel(source) {
      if (source === 'root') return '启动参数指定'
      if (source === 'dir') return '由配置项 dir 决定'
      if (source === 'DSH_HOME') return '由 DSH_HOME 环境变量决定'
      return '默认位置'
    }

    /** Thin fetch wrapper: prefixes `/memory-ui`, flattens validation errors, throws on non-2xx. */
    async function api(path, options) {
      var response = await fetch('/memory-ui' + path, options)
      var body = null
      try { body = await response.json() } catch (error) { body = null }
      if (!response.ok) {
        var message = body && body.errors ? body.errors.join('；') : (body && body.message) || ('HTTP ' + response.status)
        throw new Error(message)
      }
      return body
    }

    /** One controlled input plus its provenance badge, override notice and risk hint. */
    function Field(props) {
      var field = props.field
      var value = props.value
      var meta = props.meta || { source: 'default' }
      var id = 'tm-field-' + field.key.replace(/[^a-zA-Z0-9_-]/g, '-')
      var control
      if (field.type === 'bool') {
        control = h('div', { className: 'tm-check' },
          h('input', { id: id, type: 'checkbox', checked: value === true, onChange: function (event) { props.onChange(event.target.checked) } }),
          h('label', { htmlFor: id, title: field.tip }, field.label,
            h('span', { className: 'tm-help', title: field.tip }, '?')))
      } else if (field.type === 'select') {
        control = h('div', null,
          h('label', { htmlFor: id, title: field.tip }, field.label,
            h('span', { className: 'tm-help', title: field.tip }, '?')),
          h('select', { id: id, value: value, onChange: function (event) { props.onChange(event.target.value) } },
            field.options.map(function (option) { return h('option', { key: option, value: option }, option) })))
      } else {
        control = h('div', null,
          h('label', { htmlFor: id, title: field.tip }, field.label,
            h('span', { className: 'tm-help', title: field.tip }, '?')),
          h('input', {
            id: id,
            type: field.type === 'number' ? 'number' : 'text',
            value: value,
            min: field.min,
            max: field.max,
            placeholder: field.placeholder || '',
            onChange: function (event) { props.onChange(event.target.value) },
          }))
      }
      return h('div', { className: 'tm-field' },
        control,
        h('span', { className: 'tm-src tm-src-' + meta.source, title: sourceNote(meta.source) }, sourceLabel(meta.source)),
        meta.source === 'patch' ? h('div', { className: 'tm-override' }, sourceNote('patch')) : null,
        field.risk ? h('div', { className: 'tm-risk' }, field.risk) : null)
    }

    /**
     * The whole settings section: load once on mount, edit locally, then PUT
     * the complete known set. The host caches some values, so a successful
     * save is reported as "restart DSH to take effect" rather than pretending
     * the change is already live.
     */
    function MemorySection() {
      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var valuesState = React.useState({})
      var values = valuesState[0]
      var setValues = valuesState[1]
      var statusState = React.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]
      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]

      var load = React.useCallback(function () {
        setStatus({ kind: 'muted', text: '正在读取配置…' })
        api('/api/config').then(function (next) {
          setData(next)
          setValues(valuesOf(next.effective))
          var problems = (next.errors || []).concat(next.warnings || [])
          setStatus(problems.length
            ? { kind: 'warn', text: problems.join('；') }
            : { kind: 'muted', text: next.firstRun ? '第一次使用：记忆默认保留 365 天，旧记忆在有日记覆盖后会自动清理。' : '已读取配置。改完点「保存配置」，重启 DSH 后生效。' })
        }).catch(function (error) {
          // A 404 here usually means the host-side /memory-ui route was not
          // registered (the plugin was updated but DSH not restarted). Say
          // that instead of surfacing a bare HTTP status.
          setStatus({
            kind: 'err',
            text: '读取配置失败（' + error.message + '）。请确认改完配置后重启过 DSH，或点「重新读取」再试一次。',
          })
        })
      }, [])

      React.useEffect(function () { load() }, [load])

      function update(key, value) {
        setValues(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = value
          return next
        })
      }

      function save() {
        setSaving(true)
        setStatus({ kind: 'muted', text: '正在保存…' })
        api('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadOf(values)),
        }).then(function (result) {
          setData(function (previous) { return Object.assign({}, previous, result) })
          setValues(valuesOf(result.effective))
          var problems = (result.errors || []).concat(result.warnings || [])
          setStatus({
            kind: problems.length ? 'warn' : 'ok',
            text: '已保存。重启 DSH 后生效（保存路径：' + result.configFile + '）。' + (problems.length ? ' ' + problems.join('；') : ''),
          })
        }).catch(function (error) {
          setStatus({ kind: 'err', text: '保存失败：' + error.message + '。改动没有写进去，可以再点一次「保存配置」。' })
        }).finally(function () {
          setSaving(false)
        })
      }

      if (!data) {
        return h('div', { className: 'tm-wrap' },
          h('div', { className: 'tm-card' },
            h('h3', null, '记忆'),
            h('div', { className: status && status.kind === 'err' ? 'tm-status tm-err' : 'tm-status tm-muted' }, status ? status.text : '正在读取配置…'),
            h('div', { className: 'tm-actions' },
              h('button', { className: 'tm-btn secondary', onClick: load }, '重试'))))
      }

      return h('div', { className: 'tm-wrap' },
        h('div', { className: 'tm-card' },
          h('h3', null, '记忆'),
          h('div', { className: 'tm-paths' },
            h('div', null, '数据目录：' + data.root + '（' + rootLabel(data.rootSource) + '）'),
            h('div', null, '配置文件：' + data.configFile),
            h('div', null, '每个设置下面标着「部署固定 / 已保存 / 默认值」。你看到的是最终生效的那个值。')),
          h('div', { className: 'tm-status tm-' + (status ? status.kind : 'muted'), style: { marginTop: '8px' } }, status ? status.text : ''),
          h('div', { className: 'tm-actions', style: { marginTop: '10px' } },
            h('button', { className: 'tm-btn', onClick: save, disabled: saving }, saving ? '正在保存…' : '保存配置'),
            h('button', { className: 'tm-btn secondary', onClick: load, disabled: saving }, '重新读取'))),
        GROUPS.map(function (group) {
          return h('div', { className: 'tm-card', key: group.title },
            h('h3', null, group.title),
            h('div', { className: 'tm-grid' }, group.keys.map(function (key) {
              var field = FIELD_BY_KEY[key]
              var meta = (data.fields && data.fields[key]) || { source: 'default' }
              return h(Field, {
                key: key,
                field: field,
                value: values[key],
                meta: meta,
                onChange: function (value) { update(key, value) },
              })
            })))
        }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'memory',
            order: 25,
            label: '记忆',
          }, MemorySection)
        })
      },
    }
  },
})
