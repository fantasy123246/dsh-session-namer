/**
 * Demonstration of the display-width clamp.
 *
 * Feeds a set of over-long candidate titles through the provider with a stub
 * model, so the exact text a real run would accept is visible without a call.
 *
 * Usage: node tests/clamp.mjs
 */
const { apply } = await import('../lib/index.js')

const CANDIDATES = [
  '插件通道拦截绕过的四层防御补丁实现',
  '删除旧反代，保留插件并清理遗留配置',
  '给 dsh 写一个自动修正工作区会话名称的插件',
  '终端防护误判后恢复与防复发检查',
  'Investigate why the gateway rejects requests with code 11128',
  'deploy the reverse proxy and then clean up the leftovers',
]

let answer = ''
const services = {
  llm: {
    stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  },
  sessions: { get: () => undefined, list: () => [] },
  sessionTitle: { register: () => () => {}, get: () => null, refresh: async () => {} },
  tools: { register: () => () => {} },
  webServer: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
}

let provider = null
const ctx = {
  ...services,
  get: (key) => services[key],
  inject: (_names, callback) => callback(ctx),
  effect: () => () => {},
  on: () => () => {},
  logger: { warn: () => {} },
}
services.sessionTitle.register = (candidate) => {
  provider = candidate
  return () => {}
}

apply(ctx, { provider: 'p', model: 'm' })

const session = {
  id: 'session-clamp-demo',
  header: { cwd: 'C:\\work', agentPreset: 'standard' },
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  snapshotEvents: () => [],
}

for (const candidate of CANDIDATES) {
  answer = candidate
  const result = await provider.generate({
    session,
    messages: [{ seq: 1, text: '你好' }],
    route: { provider: 'p', model: 'm' },
    signal: undefined,
  })
  const before = [...candidate].reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0)
  const after = [...result.title].reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0)
  console.log(`${String(before).padStart(3)} → ${String(after).padStart(3)}  ${result.title}`)
}
