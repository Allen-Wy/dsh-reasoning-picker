/**
 * dsh-reasoning-picker —— 宿主编（host half）
 *
 * 两条回环路由：
 *  - POST /reasoning-picker/evaluate ：读输入框草稿 + 近期对话，交给轻量模型
 *    判断该用 Flash 还是 Pro 以及推理等级，返回推荐结果（不应用）。
 *  - POST /reasoning-picker/apply    ：把推荐结果（provider/model/effort）
 *    写进当前会话的模型选择。
 *
 * 绝不自动发消息，发送权始终在用户手里。
 */

const PREFIX = '/reasoning-picker'
const EVALUATE_ENDPOINT = '/reasoning-picker/evaluate'
const APPLY_ENDPOINT = '/reasoning-picker/apply'

export const name = 'reasoning-picker'
// 只把 llm 设为硬依赖；webServer/sessions/agentDefaultModel/sessionController
// 都是可选服务，用 ctx.get / ctx.inject 取，缺失时降级而不是让整条插件 pending。
export const inject = ['llm']

const DEFAULTS = {
  enabled: true,
  flashProvider: '',
  flashModel: '',
  proProvider: '',
  proModel: '',
  maxRecentMessages: 6,
  maxRecentChars: 1400,
  maxDraftChars: 4000,
  timeoutMs: 15000,
  maxBodyBytes: 200000,
}

function readConfig(config) {
  return { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
}

/* ---------------------------------------------------------------- loopback */

const TRUSTED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

function isLoopbackRequest(req) {
  const address = req.socket.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function hostnameOf(hostHeader) {
  const trimmed = String(hostHeader).trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

function portOf(hostHeader) {
  const trimmed = String(hostHeader).trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return null
    const rest = trimmed.slice(end + 1)
    return rest.startsWith(':') ? rest.slice(1) || null : null
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? null : trimmed.slice(colon + 1) || null
}

function bareHostname(url) {
  const host = url.hostname.toLowerCase()
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function effectivePort(url) {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

function isTrustedOrigin(origin, expectedPort) {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (!TRUSTED_HOSTNAMES.has(bareHostname(url))) return false
    return expectedPort === null || effectivePort(url) === expectedPort
  } catch {
    return false
  }
}

function isTrustedRequest(req) {
  if (req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined) return false
  if (!isLoopbackRequest(req)) return false
  const host = req.headers.host
  if (typeof host !== 'string' || host.trim() === '') return true
  if (!TRUSTED_HOSTNAMES.has(hostnameOf(host))) return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.trim() !== '' && !isTrustedOrigin(origin, portOf(host))) return false
  return true
}

/* ------------------------------------------------------------------- http */

async function readBoundedJson(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  } catch {
    /* socket already gone */
  }
}

/* ------------------------------------------------------------------- text */

function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text + '\n'
  }
  return out.trim()
}

async function recentContext(ctx, sessionId, cfg) {
  try {
    const sessions = ctx.get('sessions')
    if (!sessions || typeof sessions.get !== 'function') return ''
    const session = sessions.get(sessionId)
    if (!session || typeof session.deriveMessages !== 'function') return ''
    const derived = session.deriveMessages()
    if (!Array.isArray(derived)) return ''
    const tail = derived.slice(-cfg.maxRecentMessages)
    let budget = cfg.maxRecentChars
    const parts = []
    for (let i = tail.length - 1; i >= 0 && budget > 0; i--) {
      const msg = tail[i]
      const text = extractText(msg && msg.content)
      if (!text) continue
      const slice = text.length > budget ? text.slice(0, budget) : text
      parts.unshift(String((msg && msg.role) || 'user') + ': ' + slice)
      budget -= slice.length
    }
    return parts.join('\n')
  } catch {
    return ''
  }
}

/* ----------------------------------------------------------------- models */

async function fetchCatalog(ctx) {
  try {
    const sc = ctx.get('sessionController')
    if (sc && typeof sc.modelCatalog === 'function') {
      const catalog = await sc.modelCatalog()
      if (catalog && Array.isArray(catalog.groups)) return catalog
    }
  } catch {
    /* fall through */
  }
  return undefined
}

function flattenCatalog(catalog) {
  const out = []
  if (!catalog) return out
  for (const group of catalog.groups || []) {
    if (!group || !Array.isArray(group.models)) continue
    for (const m of group.models) {
      if (m && typeof m.id === 'string') {
        out.push({ provider: group.id, model: m.id, name: m.name || m.id, reasoning: m.reasoning })
      }
    }
  }
  return out
}

function currentSelection(ctx) {
  try {
    const adm = ctx.get('agentDefaultModel')
    if (adm && typeof adm.currentSelection === 'function') {
      const sel = adm.currentSelection()
      if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
        return { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort }
      }
    }
  } catch {
    /* fall through */
  }
  return undefined
}

async function resolveTiers(ctx, cfg) {
  const catalog = await fetchCatalog(ctx)
  const all = flattenCatalog(catalog)
  const catalogDefault = catalog && catalog.default && typeof catalog.default.provider === 'string'
    ? { provider: catalog.default.provider, model: catalog.default.model, reasoningEffort: catalog.default.reasoningEffort }
    : undefined
  const sel = currentSelection(ctx) || catalogDefault
  const byName = (re) => all.find((m) => re.test(String(m.model).toLowerCase()) || re.test(String(m.name).toLowerCase()))

  let flash
  if (cfg.flashModel && cfg.flashProvider) flash = { provider: cfg.flashProvider, model: cfg.flashModel }
  else if (cfg.flashModel && sel) flash = { provider: sel.provider, model: cfg.flashModel }
  else flash = byName(/flash/)

  let pro
  if (cfg.proModel && cfg.proProvider) pro = { provider: cfg.proProvider, model: cfg.proModel }
  else if (cfg.proModel && sel) pro = { provider: sel.provider, model: cfg.proModel }
  else pro = byName(/pro/)

  if (!flash && sel) flash = { provider: sel.provider, model: sel.model }
  if (!pro && sel) pro = { provider: sel.provider, model: sel.model }
  return { flash, pro, all, sel }
}

const EFFORT_RANK = { off: 0, none: 0, minimal: 0, low: 1, medium: 2, high: 3, max: 4, xhigh: 4 }

function pickEffort(desired, reasoning) {
  const efforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : []
  const ids = efforts.map((e) => e && e.id).filter(Boolean)
  if (ids.length === 0) return desired
  const norm = (s) => String(s || '').toLowerCase()
  const exact = ids.find((id) => norm(id) === norm(desired))
  if (exact) return exact
  const rank = EFFORT_RANK[norm(desired)]
  if (rank === undefined) return ids[Math.floor(ids.length / 2)]
  // 把 0..3 的期望强度按比例映射到该模型实际支持的档位列表
  const idx = Math.round((Math.min(rank, 3) / 3) * (ids.length - 1))
  return ids[idx]
}

/** 评估用模型的最低档（快速/省钱）；找不到就省略 reasoningEffort。 */
async function lowestEffort(ctx, route) {
  try {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : []
    const by = (re) =>
      efforts.find((e) => re.test(String((e && e.id) || '').toLowerCase()) || re.test(String((e && e.name) || '').toLowerCase()))
    const found = by(/off/) || by(/none/) || by(/minimal/) || by(/low/)
    return found ? found.id : undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------ classify LLM */

const TIER_LABEL = { flash: 'Flash', pro: 'Pro' }

function effortRank(id) {
  const r = EFFORT_RANK[String(id || '').toLowerCase()]
  return r === undefined ? 2 : r
}

function effortsOf(meta) {
  const list = meta && meta.reasoning && Array.isArray(meta.reasoning.efforts) ? meta.reasoning.efforts : []
  const mapped = list
    .map((e) => ({ id: e && e.id, name: String((e && (e.name || e.id)) || '') }))
    .filter((e) => e.id)
  if (mapped.length) return mapped
  // 拿不到模型能力信息时的兜底
  return [
    { id: 'off', name: 'off' },
    { id: 'low', name: 'low' },
    { id: 'high', name: 'high' },
  ]
}

/** 依模型真实支持的档位构造「从低到高」的推荐阶梯，不写死 medium。 */
function buildLadder(tiers) {
  const combos = []
  const flashModel = tiers.flash && tiers.flash.model
  const proModel = tiers.pro && tiers.pro.model
  const flashMeta = tiers.all.find((m) => m.model === flashModel)
  const proMeta = tiers.all.find((m) => m.model === proModel)
  const push = (tier, meta) => {
    const efforts = effortsOf(meta)
      .slice()
      .sort((a, b) => effortRank(a.id) - effortRank(b.id))
    for (const e of efforts) {
      const rank = effortRank(e.id)
      if (rank >= 4) continue // max/xhigh 默认不进阶梯，避免动不动就顶格
      if (tier === 'pro' && rank === 0) continue // Pro 从 low 起步
      combos.push({ tier, effort: e.id, effortName: e.name || e.id })
    }
  }
  push('flash', flashMeta)
  // 当 Pro 与 Flash 实际是同一模型时只保留一份，避免阶梯重复
  if (proModel && proModel !== flashModel) push('pro', proMeta)
  return combos
}

function buildSystemPrompt(combos) {
  const lines = [
    '你是「推理难度评估器」。根据用户的当前草稿（可能附带上文），从下列档位里挑一个最合适的。',
    '只输出一个 JSON 对象，不要代码块、不要解释：',
    '{"level":1-' + combos.length + ',"reason":"不超过20字的中文理由"}',
    '可选档位（从低到高）：',
  ]
  combos.forEach((c, i) => {
    const ratio = combos.length > 1 ? i / (combos.length - 1) : 0
    const hint = ratio <= 0.15 ? '极简单' : ratio <= 0.4 ? '简单' : ratio <= 0.6 ? '中等' : ratio <= 0.85 ? '偏难' : '极难'
    lines.push(i + 1 + '=' + (TIER_LABEL[c.tier] || c.tier) + '·' + c.effortName + ' ' + hint)
  })
  lines.push('注意：难度要尽量分散，不要只会给最低档；但除确实极难外，不要给最高档。')
  return lines.join('\n')
}

async function classify(ctx, cfg, route, effort, systemPrompt, draft, recent, sessionId) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm service unavailable')
  if (!route) throw new Error('no routable model')

  const userText = recent ? '【近期对话】\n' + recent + '\n\n【当前草稿】\n' + draft : draft
  const messages = [{ role: 'user', content: [{ type: 'text', text: userText }] }]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  let out = ''
  try {
    const generate = {
      provider: route.provider,
      model: route.model,
      system: systemPrompt,
      messages,
      temperature: 0,
      maxTokens: 300,
      signal: controller.signal,
    }
    if (effort) generate.reasoningEffort = effort
    if (sessionId) generate.sessionId = sessionId
    for await (const chunk of llm.stream(generate)) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
  } finally {
    clearTimeout(timer)
  }
  return out
}

function parseVerdict(out) {
  const match = String(out || '').match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const parsed = JSON.parse(match[0])
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    /* not JSON */
  }
  return undefined
}

/** 把模型返回归一到 1..max 的难度阶梯；兼容旧的 tier/effort 格式。 */
function normalizeLevel(verdict, max) {
  const clamp = (n) => Math.max(1, Math.min(max, n))
  const n = Number(verdict && verdict.level)
  if (Number.isFinite(n) && n >= 1) return clamp(Math.round(n))
  const tier = String((verdict && verdict.tier) || '').toLowerCase()
  const effort = String((verdict && verdict.effort) || 'low').toLowerCase()
  const e = effortRank(effort)
  if (tier === 'pro') return clamp(Math.ceil(max / 2) + Math.min(e, max - Math.ceil(max / 2)))
  return clamp(e + 1)
}

/* ---------------------------------------------------------------- handlers */

async function serveEvaluate(ctx, cfg, req, res) {
  if (!isTrustedRequest(req)) return writeJson(res, 403, { ok: false, error: { code: 'forbidden' } })
  if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: { code: 'method' } })
  let body
  try {
    body = await readBoundedJson(req, cfg.maxBodyBytes)
  } catch (error) {
    return writeJson(res, 413, { ok: false, error: { code: 'body', message: String(error && error.message) } })
  }
  const record = body && typeof body === 'object' ? body : {}
  const draft = typeof record.text === 'string' ? record.text.slice(0, cfg.maxDraftChars) : ''
  const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
  if (!draft.trim()) return writeJson(res, 422, { ok: false, error: { code: 'empty' } })

  try {
    const recent = sessionId ? await recentContext(ctx, sessionId, cfg) : ''
    const tiers = await resolveTiers(ctx, cfg)
    const combos = buildLadder(tiers)
    if (!combos.length) return writeJson(res, 500, { ok: false, error: { code: 'no-route' } })
    const evaluatorRoute = tiers.flash || tiers.pro
    const evaluatorEffort = await lowestEffort(ctx, evaluatorRoute)
    const systemPrompt = buildSystemPrompt(combos)
    const out = await classify(ctx, cfg, evaluatorRoute, evaluatorEffort, systemPrompt, draft, recent, sessionId)
    const verdict = parseVerdict(out) || {}
    const level = normalizeLevel(verdict, combos.length)
    const slot = combos[level - 1]
    const route = slot.tier === 'pro' ? tiers.pro || tiers.flash : tiers.flash || tiers.pro
    if (!route) return writeJson(res, 500, { ok: false, error: { code: 'no-route' } })
    const isPro = slot.tier === 'pro' && !!tiers.pro && route.provider === tiers.pro.provider && route.model === tiers.pro.model
    return writeJson(res, 200, {
      ok: true,
      value: {
        level,
        levels: combos.length,
        tier: isPro ? 'pro' : 'flash',
        tierLabel: isPro ? 'Pro' : 'Flash',
        provider: route.provider,
        model: route.model,
        reasoningEffort: slot.effort,
        reason: typeof verdict.reason === 'string' ? verdict.reason.slice(0, 40) : '',
      },
    })
  } catch (error) {
    return writeJson(res, 502, {
      ok: false,
      error: { code: 'evaluate-failed', message: String(error && error.message ? error.message : error) },
    })
  }
}

async function serveApply(ctx, cfg, req, res) {
  if (!isTrustedRequest(req)) return writeJson(res, 403, { ok: false, error: { code: 'forbidden' } })
  if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: { code: 'method' } })
  let body
  try {
    body = await readBoundedJson(req, 20000)
  } catch {
    return writeJson(res, 413, { ok: false, error: { code: 'body' } })
  }
  const record = body && typeof body === 'object' ? body : {}
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
  const provider = typeof record.provider === 'string' ? record.provider : ''
  const model = typeof record.model === 'string' ? record.model : ''
  const reasoningEffort = typeof record.reasoningEffort === 'string' && record.reasoningEffort ? record.reasoningEffort : ''
  if (!provider || !model) return writeJson(res, 422, { ok: false, error: { code: 'invalid' } })

  const selection = { provider, model }
  if (reasoningEffort) selection.reasoningEffort = reasoningEffort
  try {
    const sessionController = ctx.get('sessionController')
    if (sessionId && sessionController && typeof sessionController.selectModel === 'function') {
      await sessionController.selectModel({ sessionId, ...selection })
      return writeJson(res, 200, { ok: true, value: { via: 'session', selection } })
    }
    const agentDefaultModel = ctx.get('agentDefaultModel')
    if (agentDefaultModel && typeof agentDefaultModel.saveSelection === 'function') {
      await agentDefaultModel.saveSelection(selection)
      return writeJson(res, 200, { ok: true, value: { via: 'default', selection } })
    }
    return writeJson(res, 500, { ok: false, error: { code: 'no-controller' } })
  } catch (error) {
    return writeJson(res, 502, {
      ok: false,
      error: { code: 'apply-failed', message: String(error && error.message ? error.message : error) },
    })
  }
}

/* ---------------------------------------------------------------- install */

export function apply(ctx, config) {
  const cfg = readConfig(config)
  console.log('[reasoning-picker] host apply v5 dsh-reasoning-picker')

  ctx.inject(['webServer'], (routeCtx) => {
    const webserver = routeCtx.get('webServer')
    if (!webserver || typeof webserver.register !== 'function') return
    routeCtx.effect(() => {
      const dispose = webserver.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => {
          let pathname = PREFIX
          try {
            pathname = new URL(req.url || '/', 'http://x').pathname
          } catch {
            /* keep prefix */
          }
          if (pathname === EVALUATE_ENDPOINT) return serveEvaluate(ctx, cfg, req, res)
          if (pathname === APPLY_ENDPOINT) return serveApply(ctx, cfg, req, res)
          return writeJson(res, 404, { ok: false, error: { code: 'not-found' } })
        },
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* already torn down */
        }
      }
    }, 'reasoning-picker: routes')
  })

  // 启动时把当前真实阶梯打进日志，方便核对模型实际支持的档位
  ctx.inject(['sessionController'], (probeCtx) => {
    probeCtx.effect(() => {
      let cancelled = false
      ;(async () => {
        try {
          const tiers = await resolveTiers(ctx, cfg)
          const combos = buildLadder(tiers)
          if (!cancelled) {
            console.log(
              '[reasoning-picker] ladder ' +
                combos.map((c, i) => i + 1 + '=' + (TIER_LABEL[c.tier] || c.tier) + '·' + c.effortName).join(' | '),
            )
          }
        } catch (error) {
          if (!cancelled) console.log('[reasoning-picker] ladder failed: ' + String(error && error.message ? error.message : error))
        }
      })()
      return () => {
        cancelled = true
      }
    }, 'reasoning-picker: ladder probe')
  })
}
