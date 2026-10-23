/**
 * Smoke test for the host half.
 *
 * Loads `lib/index.js` against a stub cordis context and drives everything that
 * does not need a live DSH process: provider registration and generation, the
 * title prompt, the tool, the HTTP routes, and the refinement enrolment rule.
 *
 * Run: node tests/smoke.mjs
 */
import assert from 'node:assert/strict'

const MODULE = new URL('../lib/index.js', import.meta.url)

/**
 * Build a stub cordis context.
 *
 * Real cordis exposes an injected service as `ctx.<name>`, so the stub does the
 * same by copying every service onto the context object.
 *
 * @param services - service implementations keyed by service name.
 * @returns a context plus the collections the test inspects.
 */
function makeCtx(services) {
  const effects = []
  const listeners = new Map()
  const warns = []
  const ctx = {
    logger: { warn: (text) => warns.push(text) },
    effect(factory, label) {
      const dispose = typeof factory === 'function' ? factory() : undefined
      effects.push({ label, dispose })
      return dispose
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    get(name) {
      return services[name]
    },
    inject(names, callback) {
      for (const name of names) {
        if (services[name] === undefined) throw new Error(`stub ctx: missing service ${name}`)
      }
      callback(ctx)
      return () => {}
    },
    /** Deliver an event to every registered listener. */
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    effects,
    listeners,
    warns,
  }
  return Object.assign(ctx, services)
}

/** Fake a node request/response pair against a prefix route handler. */
async function call(route, method, path, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const request = {
    method,
    url: path,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const out = { status: 0, body: '' }
  const response = {
    writeHead(status) {
      out.status = status
    },
    end(text) {
      out.body = text
    },
  }
  await route.handler(request, response)
  return { ...out, json: out.body === '' ? null : JSON.parse(out.body) }
}

/** Build a canned streaming answer. */
function answer(text, kind = 'stop') {
  return async function* () {
    if (text !== '') yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind } }
  }
}

const plugin = await import(MODULE)
assert.equal(plugin.name, 'dsh-session-namer')
assert.equal(typeof plugin.apply, 'function')

// ---------------------------------------------------------------------------
// 1. Registration surface
// ---------------------------------------------------------------------------
const providers = []
let tool = null
let route = null
let llmOptions = null
const refreshes = []
const sections = []

const sessionTitle = {
  register: (provider) => {
    providers.push(provider)
    return () => {}
  },
  get: () => ({ title: '打招呼', messageSeqs: [1], source: { kind: 'provider' } }),
  refresh: async () => {
    refreshes.push(1)
  },
}

const services = {
  sessionTitle,
  sessions: { get: () => undefined, list: () => [] },
  llm: {
    stream: (options) => {
      llmOptions = options
      return answer('**示例插件计费口径**\n')()
    },
  },
  tools: {
    register: (definition) => {
      tool = definition
      return () => {}
    },
  },
  systemPrompt: {
    section: (entry) => {
      sections.push(entry)
      return () => {}
    },
  },
  webServer: {
    register: (registration) => {
      route = registration
      return () => {}
    },
  },
}

const ctx = makeCtx(services)
plugin.apply(ctx, {})

assert.equal(ctx.warns.length, 0, `no warnings during install: ${ctx.warns.join(' | ')}`)
assert.equal(providers.length, 1, 'exactly one title provider registers')

const provider = providers[0]
assert.equal(provider.id, 'dsh-session-namer')
// `first-prompt` is the whole scope guarantee: the service only ever delegates a
// session that has no title yet, so pre-existing names are never rewritten.
assert.equal(provider.automatic, 'first-prompt')
assert.equal(typeof provider.generate, 'function')

assert.ok(tool !== null, 'the session_title tool registers')
assert.equal(tool.name, 'session_title')
assert.equal(tool.parameters.type, 'object')
assert.equal(tool.parameters.additionalProperties, false)
assert.equal(tool.timeoutMs, 90000)
assert.equal(tool.isConcurrencySafe(), false)
assert.deepEqual(tool.output.schema.required, ['ok'])

const rendered = tool.output.render({}, { ok: true, title: '备份脚本', previous: '打招呼' })
assert.equal(rendered[0].type, 'text')
assert.match(rendered[0].text, /备份脚本/u)

assert.ok(route !== null, 'the HTTP routes register')
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/dsh-session-namer')
assert.ok(sections.some((entry) => entry.name === 'tool:session_title'), 'the tool hint reaches the system prompt')

// ---------------------------------------------------------------------------
// 2. Generation: prompt, message selection, and parsing
// ---------------------------------------------------------------------------
const liveSession = {
  id: 'session-live',
  header: { cwd: 'C:/work', agentPreset: 'standard' },
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  snapshotEvents: () => [
    { type: 'user/message', seq: 4, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'user/message', seq: 9, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '做个备份脚本' }] } },
    // Injected runtime context is NOT human material; the service ignores it and
    // so must this provider.
    { type: 'user/message', seq: 10, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'workspace rules' }] } },
  ],
}

const generated = await provider.generate({
  session: liveSession,
  messages: [
    { seq: 4, text: '你好' },
    { seq: 9, text: '做个备份脚本' },
  ],
  route: { provider: 'p', model: 'm' },
  signal: undefined,
})

assert.equal(generated.title, '示例插件计费口径', 'a whole-line emphasis wrapper is unwrapped')
assert.deepEqual(generated.messageSeqs, [4, 9], 'every cited seq comes from the request, ascending')
assert.deepEqual(generated.model, { provider: 'p', model: 'm' })

assert.equal(llmOptions.provider, 'p')
assert.equal(llmOptions.model, 'm')
assert.equal(llmOptions.purpose, 'session-title')
assert.equal(llmOptions.sessionId, 'session-live')
assert.equal(llmOptions.maxTokens, 1024)

const system = llmOptions.system
assert.ok(system.includes('Never answer with a bare greeting'), 'the anti-greeting rule is present')
assert.ok(!system.includes('such as Greeting'), 'the stock greeting instruction is gone')
assert.ok(system.includes('Untitled session'), 'a greeting-only session still has a fallback')
assert.ok(!system.includes('currentTitle'), 'no anchor rules without a current provider title')

const framed = llmOptions.messages[0].content[0].text
assert.equal(llmOptions.messages[0].role, 'user')
assert.ok(framed.includes('C:/work'), 'the working directory reaches the model')
assert.ok(framed.includes('standard'), 'the agent preset reaches the model')
assert.ok(framed.startsWith('Name this session from the following JSON:'))

// A provider-sourced current title becomes an anchor and unlocks the keep rules.
await provider.generate({
  session: liveSession,
  messages: [{ seq: 4, text: '你好' }],
  route: { provider: 'p', model: 'm' },
  currentTitle: { title: '备份脚本', source: { kind: 'provider' } },
  signal: undefined,
})
assert.ok(llmOptions.system.includes('such as "thanks"'), 'anchor rules are appended')
assert.ok(llmOptions.messages[0].content[0].text.startsWith('Refine this session title'))

// A user-pinned title is never used as an anchor.
await provider.generate({
  session: liveSession,
  messages: [{ seq: 4, text: '你好' }],
  route: { provider: 'p', model: 'm' },
  currentTitle: { title: '人工改的名', source: { kind: 'user' } },
  signal: undefined,
})
assert.ok(!llmOptions.system.includes('such as "thanks"'), 'a human rename is not an anchor')

// Cost: a greeting-only input still produces a usable title.
services.llm.stream = () => answer('未命名会话')()
const greetingOnly = await provider.generate({
  session: liveSession,
  messages: [{ seq: 4, text: '你好' }],
  route: { provider: 'p', model: 'm' },
  signal: undefined,
})
assert.equal(greetingOnly.title, '未命名会话')

// A bare opener plus real work: the digest is what names the session, so it must
// reach the model and it must stay small and factual.
services.llm.stream = (options) => {
  llmOptions = options
  return answer('会话日志解压脚本')()
}
const busySession = {
  ...liveSession,
  snapshotEvents: () => [
    { type: 'user/message', seq: 4, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'tool/call', seq: 20, data: { name: 'pwsh', arguments: '{"command":"Get-ChildItem"}' } },
    { type: 'tool/call', seq: 21, data: { name: 'write', arguments: '{"file_path":"C:/work/_sn_titles.py","content":"x"}' } },
    { type: 'tool/call', seq: 22, data: { name: 'read', arguments: '{"file_path":"C:/work/report.md"}' } },
    { type: 'job/registered', seq: 23, data: { label: 'python _sn_titles.py' } },
    // The digest is subject material, not a citation, so it covers the whole log.
    { type: 'user/message', seq: 40, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '后来的话' }] } },
    { type: 'tool/call', seq: 41, data: { name: 'compress', arguments: '{}' } },
  ],
}
await provider.generate({
  session: busySession,
  messages: [{ seq: 4, text: '你好' }],
  route: { provider: 'p', model: 'm' },
  signal: undefined,
})
const digestBody = JSON.parse(llmOptions.messages[0].content[0].text.split('\n').slice(1).join('\n'))
assert.ok(digestBody.whatTheSessionDid !== undefined, 'the activity digest reaches the model')
assert.deepEqual(digestBody.whatTheSessionDid.toolsUsed, ['pwsh', 'write', 'read', 'compress'], 'a tool used once carries no count')
assert.deepEqual(digestBody.whatTheSessionDid.filesTouched, ['_sn_titles.py', 'report.md'], 'only the basename is sent')
assert.deepEqual(digestBody.whatTheSessionDid.scriptsRun, ['_sn_titles.py'], 'scripts are recognised from pwsh commands and job labels')
assert.ok(!JSON.stringify(digestBody).includes('Get-ChildItem'), 'command bodies never reach the prompt')
assert.ok(!JSON.stringify(digestBody).includes('"content"'), 'tool argument bodies never reach the prompt')

// `includeActivity: false` turns the digest off entirely.
const providersNoDigest = []
plugin.apply(makeCtx({
  ...services,
  sessionTitle: {
    register: (p) => {
      providersNoDigest.push(p)
      return () => {}
    },
    get: () => null,
    refresh: async () => {},
  },
  llm: {
    stream: (options) => {
      llmOptions = options
      return answer('无摘要')()
    },
  },
}), { includeActivity: false })
await providersNoDigest[0].generate({
  session: busySession,
  messages: [{ seq: 4, text: '你好' }],
  route: { provider: 'p', model: 'm' },
  signal: undefined,
})
assert.ok(!llmOptions.messages[0].content[0].text.includes('whatTheSessionDid'), 'the digest can be disabled')

// A long answer is clamped to the display-width budget, at a boundary.
const cells = (text) => [...text].reduce((sum, char) => {
  const code = char.codePointAt(0)
  const wide = (code >= 0x2E80 && code <= 0xA4CF) || (code >= 0xFF00 && code <= 0xFF60)
  return sum + (wide ? 2 : 1)
}, 0)
services.llm.stream = () => answer('删除旧反代，保留插件并清理遗留配置')()
const clamped = await provider.generate({
  session: liveSession,
  messages: [{ seq: 4, text: '你好' }],
  route: { provider: 'p', model: 'm' },
  signal: undefined,
})
assert.ok(cells(clamped.title) <= 32, `the title is capped at 32 cells, got ${cells(clamped.title)}: ${clamped.title}`)
assert.ok(!clamped.title.endsWith('，'), 'a trailing separator is trimmed')
assert.ok('删除旧反代，保留插件并清理遗留配置'.startsWith(clamped.title), 'clamping only truncates, never rewrites')

// Width, not character count: an English title is allowed more characters than a
// CJK one, because a Latin letter is one cell and a CJK character two.
services.llm.stream = () => answer('pnpm install fails with missing git dependency')()
const english = await provider.generate({
  session: liveSession,
  messages: [{ seq: 4, text: 'hi' }],
  route: { provider: 'p', model: 'm' },
  signal: undefined,
})
assert.ok(english.title.length > 16, `an English title may exceed 16 characters, got ${english.title.length}`)
assert.ok(cells(english.title) <= 32, 'but it still respects the same width budget')

// Failures surface as errors, not as empty titles.
services.llm.stream = () => answer('', 'error')()
await assert.rejects(
  () => provider.generate({ session: liveSession, messages: [{ seq: 4, text: 'hi' }], route: { provider: 'p', model: 'm' } }),
  /produced no text|failed/u,
)

// A route is required: with no config override and no logged header, this fails
// loudly instead of silently picking a model.
const bare = { ...liveSession, requestHeader: () => undefined }
await assert.rejects(
  () => provider.generate({ session: bare, messages: [{ seq: 1, text: 'hi' }] }),
  /no provider\/model available/u,
)

// ---------------------------------------------------------------------------
// 3. Config overrides
// ---------------------------------------------------------------------------
// The override is exercised through a fresh provider instance, so re-apply and capture it.
const providers2 = []
const ctxConfig = makeCtx({
  ...services,
  sessionTitle: {
    register: (p) => {
      providers2.push(p)
      return () => {}
    },
    get: () => null,
    refresh: async () => {},
  },
  llm: {
    stream: (options) => {
      llmOptions = options
      return answer('配置生效')()
    },
  },
  tools: { register: () => () => {} },
  webServer: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
})
plugin.apply(ctxConfig, { provider: 'cfg-provider', model: 'cfg-model', targetTitleWidth: 11 })

const cfgGenerated = await providers2[0].generate({
  session: { ...liveSession, requestHeader: () => undefined },
  messages: [{ seq: 1, text: '你好' }],
  signal: undefined,
})
assert.equal(cfgGenerated.model.provider, 'cfg-provider', 'the config route wins over the session route')
assert.equal(cfgGenerated.model.model, 'cfg-model')
assert.ok(llmOptions.system.includes('about 11 characters'), 'targetTitleWidth is configurable')

// ---------------------------------------------------------------------------
// 4. HTTP routes
// ---------------------------------------------------------------------------
const live = { ...liveSession }
let titleAfter = { title: '备份脚本', messageSeqs: [9], source: { kind: 'provider' } }
const routeServices = {
  ...services,
  sessionTitle: {
    register: () => () => {},
    get: () => titleAfter,
    refresh: async () => {
      refreshes.push(1)
      titleAfter = { title: '备份脚本', messageSeqs: [9], source: { kind: 'provider' } }
    },
  },
  sessions: { get: (id) => (id === 'session-live' ? live : undefined), list: () => [live] },
  tools: { register: () => () => {} },
  webServer: {
    register: (registration) => {
      route = registration
      return () => {}
    },
  },
  systemPrompt: { section: () => () => {} },
}
const ctxRoutes = makeCtx(routeServices)
plugin.apply(ctxRoutes, {})

const status = await call(route, 'GET', '/dsh-session-namer/status')
assert.equal(status.status, 200)
assert.equal(status.json.ok, true)
assert.equal(status.json.provider, 'dsh-session-namer')
assert.equal(status.json.automatic, 'first-prompt')

const noId = await call(route, 'POST', '/dsh-session-namer/refresh', {})
assert.equal(noId.status, 400)
assert.match(noId.json.error, /sessionId/u)

const cold = await call(route, 'POST', '/dsh-session-namer/refresh', { sessionId: 'session-cold' })
assert.equal(cold.status, 400)
assert.match(cold.json.error, /没有打开/u)

const before = refreshes.length
const ok = await call(route, 'POST', '/dsh-session-namer/refresh', { sessionId: 'session-live' })
assert.equal(ok.status, 200)
assert.equal(ok.json.ok, true)
assert.equal(ok.json.title, '备份脚本')
assert.equal(ok.json.previous, '备份脚本')
assert.equal(ok.json.changed, false)
assert.equal(refreshes.length, before + 1, 'refresh() is the only writer')

// A cross-site mutation is refused.
const cross = await call(route, 'POST', '/dsh-session-namer/refresh', { sessionId: 'session-live' }, {
  origin: 'https://evil.example',
  host: '127.0.0.1:60266',
})
assert.equal(cross.status, 403)

assert.equal((await call(route, 'GET', '/dsh-session-namer/nope')).status, 404)

// ---------------------------------------------------------------------------
// 5. Refinement enrolment — the scope guarantee
// ---------------------------------------------------------------------------
const refinements = []
const enrollServices = {
  ...services,
  sessionTitle: {
    register: (p) => {
      enrollServices.__provider = p
      return () => {}
    },
    get: () => ({ title: '打招呼', messageSeqs: [4], source: { kind: 'provider' } }),
    refresh: async (session) => {
      refinements.push(session.id)
    },
  },
  sessions: { get: (id) => (id === 'session-live' ? live : undefined), list: () => [live] },
  llm: { stream: () => answer('备份脚本')() },
  tools: { register: () => () => {} },
  webServer: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
}
const ctxEnroll = makeCtx(enrollServices)
plugin.apply(ctxEnroll, { maxRefinements: 1 })

// The session starts with exactly one human message, so the title that automatic
// naming produces cites everything there is to cite.
live.snapshotEvents = () => [
  { type: 'user/message', seq: 4, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
]

// Before any automatic naming, a turn/end must not refresh anything: this is what
// keeps sessions that predate the plugin untouched.
ctxEnroll.emit('session/event', live, { type: 'turn/end' })
await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(refinements, [], 'a session this plugin never titled is never refreshed')

// Automatic first-prompt naming enrols it.
await enrollServices.__provider.generate({
  session: live,
  messages: [{ seq: 4, text: '你好' }],
  route: { provider: 'p', model: 'm' },
  signal: undefined,
})

// The first turn after automatic naming always earns one pass: `first-prompt`
// fired on the opener, which is the moment the session has the least to name.
ctxEnroll.emit('session/event', live, { type: 'turn/end' })
await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(refinements, ['session-live'], 'the first turn after naming earns one refinement')

// A second turn that cites nothing new must not refresh.
ctxEnroll.emit('session/event', live, { type: 'turn/end' })
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(refinements.length, 1, 'no second refinement without new material')

// A newer human message does trigger one more, if the budget allows it.
const ctxMore = makeCtx({
  ...enrollServices,
  sessionTitle: {
    ...enrollServices.sessionTitle,
    refresh: async (session) => {
      refinements.push(session.id)
    },
  },
})
plugin.apply(ctxMore, { maxRefinements: 5 })
await enrollServices.__provider.generate({
  session: { ...live, id: 'session-more' },
  messages: [{ seq: 4, text: '你好' }],
  route: { provider: 'p', model: 'm' },
  signal: undefined,
})
const moreSession = {
  id: 'session-more',
  header: { cwd: 'C:/work' },
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  snapshotEvents: () => [
    { type: 'user/message', seq: 4, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'user/message', seq: 15, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续做备份' }] } },
  ],
}
enrollServices.sessions.get = (id) => (id === 'session-more' ? moreSession : undefined)
const beforeMore = refinements.length
ctxMore.emit('session/event', moreSession, { type: 'turn/end' })
await new Promise((resolve) => setTimeout(resolve, 60))
ctxMore.emit('session/event', moreSession, { type: 'turn/end' })
await new Promise((resolve) => setTimeout(resolve, 60))
assert.ok(refinements.length > beforeMore, 'a session that keeps growing keeps getting refined')
assert.ok(refinements.length - beforeMore <= 5, 'maxRefinements still caps the total')

// A human rename drops the session from the refinement set for good.
const ctxRename = makeCtx({
  ...enrollServices,
  sessionTitle: {
    register: (p) => {
      enrollServices.__provider = p
      return () => {}
    },
    get: () => ({ title: '人工改名', messageSeqs: [], source: { kind: 'user' } }),
    refresh: async (session) => {
      refinements.push(session.id)
    },
  },
})
plugin.apply(ctxRename, { maxRefinements: 5 })
await enrollServices.__provider.generate({
  session: { ...live, id: 'session-renamed' },
  messages: [{ seq: 4, text: '你好' }],
  route: { provider: 'p', model: 'm' },
  signal: undefined,
})
assert.equal(ctxRename.warns.length, 0)
const renamedSession = {
  id: 'session-renamed',
  header: { cwd: 'C:/work' },
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  snapshotEvents: () => [
    { type: 'user/message', seq: 4, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'user/message', seq: 30, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再改改' }] } },
  ],
}
enrollServices.sessions.get = (id) => (id === 'session-renamed' ? renamedSession : undefined)
const beforeRename = refinements.length
ctxRename.emit('session/event', renamedSession, { type: 'turn/end' })
await new Promise((resolve) => setTimeout(resolve, 30))
assert.equal(refinements.length, beforeRename, 'a human-pinned title is never auto-refined')

console.log('smoke: ok')
console.log(`  provider         : ${provider.id} (${provider.automatic})`)
console.log(`  tool             : ${tool.name}`)
console.log(`  routes           : ${route.kind} ${route.path}/*`)
console.log(`  parsed title     : ${generated.title}`)
console.log(`  scope guarantee  : pre-existing and pinned titles never rewritten`)
