/**
 * Offline check against a real session log.
 *
 * Reads a plain JSONL session log (produced by `tests/unpack.py`, because the
 * on-disk form is a multi-frame zstd that a single-frame decompressor truncates),
 * feeds its real events and human messages to the provider through a stub
 * context, and prints exactly what would be sent. This validates the prompt, the
 * activity digest, and the clamp on real data without spending a model call.
 *
 * Usage: node tests/replay.mjs <plain.jsonl>
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const path = process.argv[2]
const events = readFileSync(path, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))

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

const messages = humanMessages(events)
const header = events[0]

let sent = null
const services = {
  llm: {
    stream: (options) => {
      sent = options
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'PLACEHOLDER-TITLE' }
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
  logger: { warn: (line) => console.error('warn:', line) },
}
services.sessionTitle.register = (candidate) => {
  provider = candidate
  return () => {}
}

apply(ctx, { provider: 'p', model: 'm' })

const session = {
  id: basename(path),
  header,
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  snapshotEvents: () => events,
}

await provider.generate({ session, messages, route: { provider: 'p', model: 'm' }, signal: undefined })

const body = sent.messages[0].content[0].text
console.log(`=== ${messages.length} human messages, ${events.length} events`)
console.log('=== system prompt ===')
console.log(sent.system)
console.log('=== user body ===')
console.log(body)
console.log(`=== body bytes: ${Buffer.byteLength(body, 'utf8')} / budget 8192`)
