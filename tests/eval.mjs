/**
 * Emit the exact prompt the plugin would send for several real sessions.
 *
 * Writes a JSON array `[{ id, system, body }]` so a harness can post each one to
 * the real gateway and compare the resulting titles, all without restarting DSH.
 *
 * Usage: node tests/eval.mjs <out.json> <plain.jsonl>...
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const [outPath, ...inputs] = process.argv.slice(2)

function humanMessages(rows) {
  const collected = []
  for (const event of rows) {
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const text = (event.data.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
    if (text.trim() === '') continue
    collected.push({ seq: event.seq, text })
  }
  return collected
}

const { apply } = await import('../lib/index.js')

const captured = []
const services = {
  llm: {
    stream: (options) => {
      captured.push(options)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'placeholder' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
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

const rows = []
for (const input of inputs) {
  const events = readFileSync(input, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
  const messages = humanMessages(events)
  if (messages.length === 0) continue
  const session = {
    id: basename(input, '.jsonl'),
    header: events[0],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    snapshotEvents: () => events,
  }
  captured.length = 0
  await provider.generate({ session, messages, route: { provider: 'p', model: 'm' }, signal: undefined })
  rows.push({
    id: session.id,
    messages: messages.length,
    system: captured[0].system,
    body: captured[0].messages[0].content[0].text,
  })
}

writeFileSync(outPath, JSON.stringify(rows, null, 2), 'utf8')
console.log(`wrote ${rows.length} prompt(s) to ${outPath}`)
