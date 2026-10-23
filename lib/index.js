/**
 * dsh-session-namer — host half.
 *
 * Why this plugin exists: the stock `session-title-first-prompt-llm` provider
 * names a session from the *first* human message only, and its system prompt
 * explicitly tells the model to answer "Greeting" when that message is phatic:
 *
 *   "If the messages give little to name, still return a best-effort title,
 *    such as Greeting, instead of explaining."
 *
 * A workspace whose sessions open with 「你好」 therefore ends up with a sidebar
 * full of 「打招呼」 / 「简单问候」 / 「Greeting in Chinese」.
 *
 * What this plugin provides:
 *
 *  1. A replacement title provider (`automatic: 'first-prompt'`) whose prompt
 *     names the concrete subject and forbids phatic labels. It also feeds the
 *     model the working directory and agent preset, which is often the only
 *     subject material a "hello" session has.
 *  2. A bounded self-refinement loop: when a turn closes and the human has said
 *     something the current title does not cite yet, `sessionTitle.refresh()`
 *     re-runs the provider so the title follows the real work.
 *  3. Two manual entry points: a `session_title` tool the model can call, and
 *     same-origin HTTP routes backing a header button in the browser half.
 *
 * Scope guarantee — existing session names are never rewritten:
 *  - `first-prompt` only fires for a session that has no title at all yet, so
 *    the service never delegates an already-named session to this provider.
 *  - Refinement is scoped to `state.titled`, populated only by automatic
 *    first-prompt naming done by this plugin. A session that carried a title
 *    before this plugin existed never enters that map.
 *  - A title the human pinned by renaming (`source.kind === 'user'`) is dropped
 *    from `state.titled` on sight and only an explicit tool/button call may
 *    replace it.
 *  - Nothing here opens a session log or writes `session/title` directly; the
 *    only writer is `SessionTitleService`.
 *
 * Module-resolution constraint (shared with `dsh-github-connect`): a profile
 * install does not hand the official packages to a third-party plugin —
 * `profiles/<name>/node_modules/@deepseek-ai` ships only `cosmokit` and
 * `schemastery`. So this half imports node builtins only, hand-writes the tool
 * definition instead of using `defineTool`, and hand-assembles the LLM stream
 * instead of importing `BlockAssembler`.
 *
 * Cordis constraint: every inject callback is a plugin body, so it may only
 * return `undefined`, a disposer function, or a thenable — never a plain object.
 * Each callback below installs synchronously and returns `undefined`; optional
 * services are resolved lazily with `ctx.get()` at call time rather than
 * threaded through a shared runtime.
 */
import { randomUUID } from 'node:crypto'

export const name = 'dsh-session-namer'

/** Provider id recorded in each `session/title` event's `source.provider`. */
const PROVIDER_ID = 'dsh-session-namer'
/** Tool the model calls to re-title the session it runs in. */
const TOOL_NAME = 'session_title'
/** Same-origin route prefix backing the browser half. */
const ROUTE_PREFIX = '/dsh-session-namer'
/** Per-message character cap applied before the framed input is measured. */
const PER_MESSAGE_CHARS = 2000
/**
 * Bumped whenever the prompt, the digest, or the clamping changes, so `/status`
 * can answer "is the code I just edited actually loaded" without a restart guess.
 */
const REVISION = 4

const DEFAULTS = {
  /** Display-width cells to aim for; a CJK character is 2 cells, a Latin one 1. */
  targetTitleWidth: 16,
  /** Hard display-width cap; a longer answer is clamped at a boundary. */
  maxTitleWidth: 24,
  /** Byte budget for the framed input. */
  maxInputBytes: 8192,
  /** Output budget; titles are short, but reasoning models spend tokens first. */
  maxOutputTokens: 1024,
  /** Wall clock for one title generation. */
  timeoutMs: 45000,
  /** How many self-driven refinements a plugin-titled session may receive. */
  maxRefinements: 4,
  /** Minimum gap between two refinements of the same session. */
  refineGapMs: 120000,
  /** Send the session working directory as extra subject material. */
  includeCwd: true,
  /** Send a digest of what the session actually did (tools, files, scripts). */
  includeActivity: true,
  /** Explicit route override; both or neither. */
  provider: '',
  model: '',
}

const ANCHOR_RULES = [
  'An existing title is supplied as currentTitle. If it still accurately describes the main topic or task, return it exactly unchanged.',
  'Follow-up questions, additional details within the same topic, acknowledgements such as "thanks", and requests to continue do not by themselves justify a title change.',
  'Do not reword, polish, shorten, or replace synonyms in an adequate title. Keeping its exact wording takes priority over the target length.',
  'Change the title only when the messages materially change or expand the main topic or task so that the existing title is no longer accurate.',
]

const TOPIC_RULES = [
  'A title is a signpost in a list of sessions, not a summary. It has to let the human recognise which session this was, months later, at a glance.',
  'Name the whole session, not one moment of it: the subject the human worked on from the first message to the last.',
  'Name the concrete subject: the feature, the file, the error, the decision, or the question. Prefer the specific noun the human actually used — a product name, a path, an error string, a command — over a generic verb.',
  'Lead with the subject. "网关拦截补丁" is a title; "研究一下网关请求为什么会被拦截并想办法绕过" is a description of one message.',
  'If the session moves through several stages, name the object they all act on, not each stage. A session that diagnoses a failure, patches it, and cleans up leftovers is "网关拦截补丁", not "排查与清理".',
  'When the human repeats or restates the same request, that is the main subject; later side questions are not.',
  '`whatTheSessionDid` lists the tools, files, and scripts the assistant actually used. When the human messages alone are thin — a greeting, "继续", or a bare question — that field is the subject material: name what was worked on.',
  'Never answer with a bare greeting or small-talk label, and never translate one: no "Greeting", "打招呼", "你好", "问候", "New chat", "闲聊", "简单问候".',
  'Openings such as "你好" or "hi" carry no subject. When the human messages are only greetings and `whatTheSessionDid` is absent too, take the subject from the working directory and the agent preset. If nothing is inferable at all, answer "未命名会话" for CJK messages or "Untitled session" otherwise.',
  'Do not add a prefix, category, or quote around the subject, and do not enumerate every sub-task. One phrase, the subject only.',
]

const TITLE_SHAPE_RULES = [
  'Write it as a noun phrase, the way a file name or a tab is written — not as a sentence, and not as a verb phrase describing what the human said.',
  'No sentence punctuation, no trailing period, no question mark, no ellipsis, no "如何"/"怎么" framing: "插件安装失败排查", not "插件装不上怎么办".',
  'Two to four words, or one compound phrase. If the subject needs a qualifier to be unambiguous, add exactly one.',
  'Do not restate the working directory, the tool names, or the word "会话"/"session": the list already shows that these are sessions.',
]

const TOOL_HINT =
  'When a session title is generic or stale — for example a leftover greeting such as "Greeting" or "打招呼" — '
  + 'call `session_title` to regenerate it from the conversation itself.'

/**
 * Normalize the plugin config supplied by `cordis.patch.yml`.
 * @param raw - the config object from the bundle patch layer.
 * @returns concrete settings with defaults applied.
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const positive = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
  }
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  const count = Number(source.maxRefinements)
  const maxTitleWidth = positive(source.maxTitleWidth, DEFAULTS.maxTitleWidth)
  const targetTitleWidth = Math.min(positive(source.targetTitleWidth, DEFAULTS.targetTitleWidth), maxTitleWidth)
  return {
    targetTitleWidth,
    maxTitleWidth,
    maxInputBytes: positive(source.maxInputBytes, DEFAULTS.maxInputBytes),
    maxOutputTokens: positive(source.maxOutputTokens, DEFAULTS.maxOutputTokens),
    timeoutMs: positive(source.timeoutMs, DEFAULTS.timeoutMs),
    maxRefinements: Number.isFinite(count) && count >= 0 ? Math.floor(count) : DEFAULTS.maxRefinements,
    refineGapMs: positive(source.refineGapMs, DEFAULTS.refineGapMs),
    includeCwd: source.includeCwd === undefined ? DEFAULTS.includeCwd : source.includeCwd !== false,
    includeActivity: source.includeActivity === undefined ? DEFAULTS.includeActivity : source.includeActivity !== false,
    provider: text(source.provider),
    model: text(source.model),
  }
}

/**
 * Build the title prompt.
 *
 * Keeps the stock output contract (one line, natural language, target length)
 * and replaces the stock `such as Greeting` instruction with topic rules.
 *
 * @param config - normalized settings.
 * @param hasCurrentTitle - whether an earlier provider title anchors this run.
 * @returns the system prompt text.
 */
function systemPrompt(config, hasCurrentTitle) {
  const lines = [
    'Name an AI coding-assistant session from the messages of that session.',
    'Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetTitleWidth} characters of display width, and never exceed ${config.maxTitleWidth}. A CJK character counts as two cells, a Latin letter as one.`,
    ...TITLE_SHAPE_RULES,
    ...TOPIC_RULES,
  ]
  if (hasCurrentTitle) lines.push(...ANCHOR_RULES)
  return lines.join('\n')
}

/**
 * Serialize the material the model sees.
 * @param context - cwd, agent preset, title anchor, and the kept human messages.
 * @returns the one user-message body.
 */
function frameInput(context) {
  const payload = {}
  if (context.cwd !== undefined) payload.workingDirectory = context.cwd
  if (context.agentPreset !== undefined) payload.agentPreset = context.agentPreset
  if (context.currentTitle !== undefined) payload.currentTitle = context.currentTitle
  payload.humanMessages = context.messages
  if (context.activity !== undefined) payload.whatTheSessionDid = context.activity
  const lead = context.currentTitle === undefined
    ? 'Name this session from the following JSON:'
    : 'Refine this session title from the following JSON:'
  return `${lead}\n${JSON.stringify(payload)}`
}

/**
 * A cheap scalar describing how much work the session has done, so the
 * refinement loop can tell "the session moved on" from "a turn closed" without
 * re-reading or hashing anything expensive.
 * @param events - `session.snapshotEvents()`.
 * @returns the number of tool calls plus registered jobs.
 */
function activitySignature(events) {
  let count = 0
  for (const event of events) {
    if (event?.type === 'tool/call') count += 1
    else if (event?.type === 'job/registered') count += 1
  }
  return count
}

/**
 * Summarize what the session actually did, for the case that decides most bad
 * titles: the human opener is a bare "你好", and the subject only exists in the
 * work that followed.
 *
 * Reads the session's own event log (never another session's), which is the same
 * source the title service folds. Only names, paths, and command heads are kept —
 * no tool output, no assistant prose, so the digest stays small and factual.
 *
 * The whole log is summarized, not just the seqs the title ends up citing: the
 * digest is subject material for the model, not a citation, and the first turn
 * of a "你好" session happens after the opener. `messageSeqs` still cites only
 * real human messages, which is the invariant the log enforces.
 *
 * @param events - `session.snapshotEvents()`.
 * @returns a compact digest, or undefined when the session did nothing yet.
 */
function sessionDigest(events) {
  const tools = new Map()
  const files = new Map()
  const scripts = new Map()
  const noteScript = (text) => {
    // `pwsh` calls are the most informative thing a coding session logs, but the
    // raw command is 200 characters of quoting. Keep only the shape: the script
    // it runs, which is what names the work.
    const match = /([\w.-]+\.(?:py|ps1|mjs|cjs|js|sh|cmd|bat))\b/u.exec(text)
    if (match === null) return
    scripts.set(match[1], (scripts.get(match[1]) ?? 0) + 1)
  }
  for (const event of events) {
    if (event?.type === 'tool/call') {
      const tool = String(event.data?.name ?? '')
      if (tool !== '') tools.set(tool, (tools.get(tool) ?? 0) + 1)
      // Arguments carry the path or the command; only those fields are read, so a
      // large patch never enters the prompt.
      const raw = event.data?.arguments
      if (typeof raw !== 'string' || raw.length > PER_MESSAGE_CHARS * 8) continue
      try {
        const parsed = JSON.parse(raw)
        const path = parsed?.file_path ?? parsed?.path ?? parsed?.filePath
        if (typeof path === 'string' && path !== '') {
          const short = path.split(/[\\/]/u).pop() ?? path
          // Count repeats: a file written five times is the subject; one touched
          // once is scenery.
          files.set(short, (files.get(short) ?? 0) + 1)
        }
        if (tool === 'pwsh' && typeof parsed?.command === 'string') noteScript(parsed.command)
      } catch {
        // A non-JSON argument contributes no path and no script.
      }
      continue
    }
    if (event?.type === 'job/registered') noteScript(String(event.data?.label ?? ''))
  }
  const rank = (map) => [...map.entries()].sort((left, right) => right[1] - left[1])
  const rankTools = rank(tools)
  const rankFiles = rank(files)
  const rankScripts = rank(scripts)
  if (rankTools.length === 0 && rankFiles.length === 0 && rankScripts.length === 0) return undefined
  const withCount = (count, name) => (count > 1 ? `${name}×${count}` : name)
  const digest = {}
  if (rankTools.length > 0) digest.toolsUsed = rankTools.slice(0, 6).map(([tool, count]) => withCount(count, tool))
  if (rankFiles.length > 0) digest.filesTouched = rankFiles.slice(0, 6).map(([path, count]) => withCount(count, path))
  if (rankScripts.length > 0) digest.scriptsRun = rankScripts.slice(0, 4).map(([script, count]) => withCount(count, script))
  return digest
}

/**
 * Display width of one character: CJK and fullwidth forms occupy two cells,
 * everything else one. This is the unit the title budget is measured in, so a
 * 16-CJK title and a 32-Latin title get the same allowance — counting raw
 * characters instead would cap English titles at a handful of words.
 * @param char - one code point.
 * @returns 2 or 1.
 */
function cellWidth(char) {
  const code = char.codePointAt(0) ?? 0
  const wide = (code >= 0x1100 && code <= 0x115F)
    || (code >= 0x2E80 && code <= 0xA4CF)
    || (code >= 0xAC00 && code <= 0xD7A3)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE30 && code <= 0xFE6F)
    || (code >= 0xFF00 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)
    || (code >= 0x1F300 && code <= 0x1F64F)
    || (code >= 0x1F900 && code <= 0x1F9FF)
    || (code >= 0x20000 && code <= 0x3FFFD)
  return wide ? 2 : 1
}

/**
 * Clamp a title to the width budget without cutting a word or a CJK character
 * in half. Prefers a natural boundary (punctuation, space) when one is close to
 * the limit.
 * @param title - the candidate title.
 * @param maxCells - hard display-width cap.
 * @returns the clamped title.
 */
function clampTitle(title, maxCells) {
  const chars = [...title]
  let width = 0
  let fit = chars.length
  for (let index = 0; index < chars.length; index += 1) {
    width += cellWidth(chars[index])
    if (width > maxCells) {
      fit = index
      break
    }
  }
  if (fit === chars.length) return title
  const isWordChar = (char) => /[A-Za-z0-9]/u.test(char ?? '')
  // Cut at the limit. Only back off when the cut lands inside a Latin word
  // ("…the CodeBu|ddy" -> "…the"); a CJK run is cut wherever it runs out.
  let cut = fit
  while (cut > 0 && isWordChar(chars[cut - 1]) && isWordChar(chars[cut])) cut -= 1
  // A cut *inside a CJK run* strands the head of a phrase: "Acme 产品
  // 宣|传页" keeps a character that means nothing on its own. Chinese has
  // no spaces to cut at, so back off to the nearest separator instead — bounded,
  // and only for this case. A Latin cut already landed on a space or on a word
  // boundary, where backing off would throw away a whole word for nothing.
  const wide = (char) => cellWidth(char ?? ' ') === 2
  if (cut > 0 && wide(chars[cut - 1]) && wide(chars[cut] ?? '')) {
    const window = Math.min(6, Math.max(2, Math.ceil(maxCells / 4)))
    for (let index = cut; index > cut - window && index > 0; index -= 1) {
      if (/[\s，,、；;：:·\-—–/]/u.test(chars[index - 1] ?? '')) {
        cut = index - 1
        break
      }
    }
  }
  // Drop what the cut exposed: separators, plus the particles and English
  // function words that cannot end a title ("的", "，", "and").
  const dangling = /(?:[\s，,、；;：:（()）.。!！?？·\-—–的和与及并而或]+|\b(?:a|an|and|the|of|for|with|to|in|on|at|by|or|that|which|from)\b)$/iu
  let kept = chars.slice(0, cut).join('').trim()
  for (;;) {
    const trimmed = kept.replace(dangling, '').trim()
    if (trimmed === kept || trimmed === '') break
    kept = trimmed
  }
  return kept === '' ? title : kept
}

/**
 * Display width of a whole title, in the same cells the budget uses.
 * @param text - any string.
 * @returns the summed cell width.
 */
function widthOf(text) {
  let width = 0
  for (const char of text) width += cellWidth(char)
  return width
}

/**
 * Labels that name nothing. The stock prompt asks the model to fall back to
 * "such as Greeting" when the messages are thin, which is exactly the title this
 * plugin exists to remove — so a returned one is treated as a failed attempt.
 */
const PHATIC = /^(?:greetings?|hello|hi|hey|greeting\sin\s\w+|打招呼|你好|您好|问候|简单问候|闲聊|问候语|新(?:的)?会话|new\s+chat|untitled)$/iu

/**
 * Decide whether a candidate title has to be generated again.
 *
 * Kept separate from `clampTitle` on purpose: clamping is a safety net that
 * always returns something sendable, while this asks the model for a title it
 * should have produced, so the result reads as a phrase instead of a truncation.
 *
 * Only hard failures are worth a second model call. Overshooting the soft target
 * is not one of them: most good titles land between the target and the cap, and
 * retrying those would double the cost of naming every session.
 *
 * @param title - the parsed candidate.
 * @param config - normalized settings, for the width budget.
 * @returns the instruction to append for the retry, or undefined to accept.
 */
function titleProblem(title, config) {
  const stripped = title.replace(/[「」"'`]/gu, '').trim()
  if (PHATIC.test(stripped)) {
    return `Your previous answer was "${title}", which names nothing. That answer is rejected. `
      + 'Name the concrete subject this session actually worked on, taken from humanMessages or whatTheSessionDid.'
  }
  const width = widthOf(title)
  if (width > config.maxTitleWidth) {
    return `Your previous answer was "${title}", which is ${width} cells wide and exceeds the ${config.maxTitleWidth} cell limit. `
      + `That answer is rejected. Return the same subject in at most ${config.maxTitleWidth} cells — drop qualifiers, never the subject.`
  }
  return undefined
}

/**
 * Keep as many messages as the byte budget allows, but never drop the first
 * one: it states the original subject, and a long session that loses it is
 * named from its tail alone.
 *
 * The middle is dropped before either end, because a session's subject is
 * announced first and its current state is described last.
 *
 * @param messages - qualifying human messages in seq order.
 * @param maxBytes - budget for the framed input.
 * @param base - framing context without messages.
 * @returns the kept messages (still ascending) and the framed body.
 */
function fitMessages(messages, maxBytes, base) {
  const clipped = messages.map((message) => ({
    seq: message.seq,
    text: message.text.length > PER_MESSAGE_CHARS ? `${message.text.slice(0, PER_MESSAGE_CHARS)}…` : message.text,
  }))
  const frame = (rows) => frameInput({ ...base, messages: rows })
  let kept = clipped
  let framed = frame(kept)
  // Drop from the middle outward: tail first index, then head-slice growth.
  while (Buffer.byteLength(framed, 'utf8') > maxBytes && kept.length > 1) {
    const dropTail = kept.length - 2
    if (dropTail > 0) {
      kept = kept.filter((_row, index) => index !== dropTail)
    } else {
      kept = kept.slice(0, 1)
    }
    framed = frame(kept)
  }
  return { kept, framed }
}

/**
 * Pull the first usable line out of a model answer.
 *
 * Mirrors the stock parser (first non-empty line, unwrap a whole-line `*`/`**`/
 * `***` emphasis wrapper) and additionally drops a leading `Title:`-style label,
 * a Markdown heading marker, and wrapping quotes.
 *
 * @param text - raw assembled model text.
 * @returns the candidate title, or undefined when the answer carries no text.
 */
function titleFromText(text) {
  for (const rawLine of text.split(/\r?\n/u)) {
    let line = rawLine.trim()
    if (line === '') continue
    const emphasis = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u.exec(line)
    if (emphasis?.groups !== undefined && !emphasis.groups.inner.includes(emphasis.groups.marker)) {
      line = emphasis.groups.inner.trim()
    }
    line = line.replace(/^#{1,6}\s+/u, '')
    line = line.replace(/^(?:title|session title|会话名|会话名称|标题)\s*[:：]\s*/iu, '')
    line = line.replace(/^["'“”‘’「『]+/u, '').replace(/["'“”‘’」』]+$/u, '')
    line = line.trim()
    if (line !== '') return line
  }
  return undefined
}

/**
 * Accumulate a stream without importing `BlockAssembler`.
 *
 * Text comes from `text-delta` chunks; `block-end` is a fallback for adapters
 * that emit only whole blocks. Buffers are joined in index order.
 *
 * @param chunks - the async iterable from `ctx.llm.stream()`.
 * @returns the joined text plus the terminal finish reason and failure.
 */
async function collectText(chunks) {
  const buffers = new Map()
  let finish
  let failure
  for await (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') {
      const index = Number(chunk.index ?? 0)
      buffers.set(index, (buffers.get(index) ?? '') + String(chunk.text ?? ''))
      continue
    }
    if (chunk.type === 'block-end') {
      const index = Number(chunk.index ?? 0)
      const block = chunk.block
      if (buffers.get(index) === undefined && block?.type === 'text' && typeof block.text === 'string') {
        buffers.set(index, block.text)
      }
      continue
    }
    if (chunk.type === 'finish') {
      finish = chunk.reason
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
        failure = chunk.reason.failure
      }
    }
  }
  const ordered = [...buffers.entries()].sort((left, right) => left[0] - right[0]).map(([, text]) => text)
  return { text: ordered.join(''), finish, failure }
}

/**
 * Resolve the provider/model route for one title generation.
 * @param config - normalized settings.
 * @param fallback - `request.route` or the session's logged request header config.
 * @returns `{ provider, model }`.
 * @throws when no route can be found at all.
 */
function resolveRoute(config, fallback) {
  if (config.provider !== '' && config.model !== '') {
    return { provider: config.provider, model: config.model }
  }
  if (typeof fallback?.provider === 'string' && typeof fallback?.model === 'string') {
    return { provider: fallback.provider, model: fallback.model }
  }
  throw new Error(
    'session-namer: no provider/model available for title generation; set provider and model together in the plugin config',
  )
}

/**
 * Collect the qualifying human messages of a session, using the same predicate
 * the title service uses (`user/message` from a human, carrying visible text).
 * @param events - `session.snapshotEvents()`.
 * @returns `{seq, text}` pairs in ascending seq order.
 */
function humanMessagesOf(events) {
  const collected = []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const blocks = Array.isArray(event.data.content) ? event.data.content : []
    const text = blocks
      .filter((block) => block?.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
    if (text.trim() === '') continue
    collected.push({ seq: event.seq, text })
  }
  return collected
}

/** @param response - node http response. @param status - status code. @param payload - JSON body. */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Reject cross-site mutations. A missing `origin` (same-origin fetch, curl) passes.
 * @param request - node http request.
 * @returns whether the request may mutate state.
 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined || origin === 'null') return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Read and parse a small JSON body.
 * @param request - node http request.
 * @param limitBytes - maximum accepted body size.
 * @returns the parsed object, `{}` for an empty body.
 */
async function readJson(request, limitBytes = 65536) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * Mutable state shared by the three installers. Created in `apply` so every
 * inject callback closes over the same object without a ready gate.
 * @returns the state record.
 */
function createState() {
  return {
    /** Sessions this plugin titled automatically, with refinements used. */
    titled: new Map(),
    /** One-shot emphasis hints for the next generation, keyed by session id. */
    hints: new Map(),
    /** Sessions whose in-flight generation was requested manually. */
    manual: new Set(),
    /** Most recent successful generation, surfaced by `/status`. */
    last: null,
    /** Most recent generation failure, surfaced by `/status`. */
    lastError: null,
  }
}

/**
 * One title generation: frame the material, call the model, parse one line.
 *
 * `ctx.llm.stream()` is used directly rather than `prepareCall()`: the runtime
 * validates a prepared call against its resolved config, and a hand-built
 * config object would have to reproduce that byte for byte.
 *
 * @param ctx - context carrying `llm`.
 * @param config - normalized settings.
 * @param request - the title service's provider request.
 * @param hint - optional free-form steer from a manual caller.
 * @returns `{ title, messageSeqs, model }`.
 */
async function generateTitle(ctx, config, request, hint) {
  const route = resolveRoute(config, request.route ?? request.session.requestHeader()?.config)
  const anchor = request.currentTitle?.source?.kind === 'provider' ? request.currentTitle.title : undefined
  const base = {
    cwd: config.includeCwd ? request.session.header?.cwd : undefined,
    agentPreset: request.session.header?.agentPreset,
    currentTitle: anchor,
  }
  const { kept, framed: rawFramed } = fitMessages(request.messages, config.maxInputBytes, base)
  if (kept.length === 0) throw new Error('session-namer: no source message to name this session from')
  const digest = config.includeActivity
    ? sessionDigest(request.session.snapshotEvents())
    : undefined
  const framedBase = digest === undefined
    ? rawFramed
    : frameInput({ ...base, messages: kept, activity: digest })
  const emphasis = hint === undefined || hint === ''
    ? ''
    : `\nThe requester asks for this emphasis: ${hint}`
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  // One retry, and only for a rejected answer: the first pass occasionally comes
  // back with a greeting (the stock prompt taught models to do exactly that) or
  // overshoots the width, and truncating it produces "Acme 产品 宣" instead of a
  // phrase. A second call costs one more model request and turns that into a
  // good title.
  const ask = async (body) => {
    const { text, finish, failure } = await collectText(ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: body }],
          source: { kind: 'dsh-session-namer' },
          id: randomUUID(),
        },
      ],
      system: systemPrompt(config, anchor !== undefined),
      maxTokens: config.maxOutputTokens,
      sessionId: request.session.id,
      purpose: 'session-title',
      signal,
    }))
    return { text, finish, failure }
  }
  const parse = (reply) => {
    const candidate = titleFromText(reply.text)
    if (candidate === undefined) {
      if (reply.finish?.kind === 'error' || reply.finish?.kind === 'aborted') {
        throw new Error(`session-namer: title model failed: ${reply.failure?.message ?? reply.finish.kind}`)
      }
      throw new Error(`session-namer: title model produced no text (finish: ${reply.finish?.kind ?? 'unknown'})`)
    }
    return candidate
  }
  const first = parse(await ask(framedBase + emphasis))
  let candidate = first
  const problem = signal.aborted ? undefined : titleProblem(first, config)
  if (problem !== undefined) {
    try {
      const retry = parse(await ask(`${framedBase}${emphasis}\n${problem}`))
      // Keep the retry only if it is actually better: a model that ignores the
      // correction twice must not leave the session unnamed.
      if (titleProblem(retry, config) === undefined) candidate = retry
    } catch {
      // A failed retry is not a failed title: the first answer still stands.
    }
  }
  return {
    title: clampTitle(candidate, config.maxTitleWidth),
    messageSeqs: kept.map((message) => message.seq),
    model: { provider: route.provider, model: route.model },
  }
}

/**
 * Register the replacement title provider and the bounded refinement loop.
 *
 * @param ctx - context carrying `sessionTitle` and `sessions`.
 * @param config - normalized settings.
 * @param state - the shared state record.
 */
function installProvider(ctx, config, state) {
  ctx.sessionTitle.register({
    id: PROVIDER_ID,
    // `first-prompt` is deliberate. `all-prompts` would make the service
    // schedule this provider on every human message of every live session,
    // reaching into sessions that were already named before this plugin
    // existed. `first-prompt` only fires for a session that has no title yet,
    // so existing names are never rewritten; later improvements come from the
    // refinement loop below, scoped to sessions this plugin named itself.
    automatic: 'first-prompt',
    async generate(request) {
      const sessionId = request.session.id
      const hint = state.hints.get(sessionId)
      const isManual = state.manual.has(sessionId)
      state.hints.delete(sessionId)
      try {
        const result = await generateTitle(ctx, config, request, hint)
        state.last = {
          sessionId,
          title: result.title,
          previous: request.currentTitle?.title ?? null,
          model: result.model,
          manual: isManual,
          at: Date.now(),
        }
        state.lastError = null
        if (!isManual && !state.titled.has(sessionId)) {
          state.titled.set(sessionId, { refinements: 0, signature: 0 })
        }
        return result
      } catch (error) {
        state.lastError = {
          sessionId,
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        }
        throw error
      }
    },
  })

  // Self-driven refinement: after a turn closes, re-run the provider when the
  // session has outgrown the title it currently carries. Only sessions this
  // plugin titled enter `state.titled`, which is what keeps pre-existing
  // sessions untouched.
  //
  // Why a second pass is needed at all: `first-prompt` fires on the opening
  // message, which is exactly the moment the session has the least to name —
  // a "你好" plus a working directory. The subject appears only once work
  // starts, so the title is regenerated after the turn that reveals it.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const entry = state.titled.get(session.id)
    if (entry === undefined) return
    if (entry.refinements >= config.maxRefinements) return
    if (ctx.sessions.get(session.id) !== session) return
    const current = ctx.sessionTitle.get(session)
    // A title the human pinned by renaming must never be overwritten here; only
    // an explicit call may replace it.
    if (current?.source?.kind === 'user') {
      state.titled.delete(session.id)
      return
    }
    const events = session.snapshotEvents()
    const human = humanMessagesOf(events)
    if (human.length === 0) return
    const now = Date.now()
    // A refinement is a model call on someone else's turn; never let a burst of
    // short turns turn into a burst of them.
    if (entry.at !== undefined && now - entry.at < config.refineGapMs) return
    const cited = Array.isArray(current?.messageSeqs) ? current.messageSeqs : []
    let citedNewest = -1
    for (const seq of cited) citedNewest = Math.max(citedNewest, Number(seq))
    const newerMessage = citedNewest < human[human.length - 1].seq
    const signature = activitySignature(events)
    // The first turn always earns a pass: the opener alone ("你好") never names
    // the session, and the first turn is where the subject usually lands.
    const eager = entry.refinements === 0 && entry.signature === 0
    // After that, only real movement counts: a new human message, or enough new
    // tool calls that the session has visibly become a different piece of work.
    const grew = entry.signature > 0 && signature >= entry.signature + 8
    if (!newerMessage && !eager && !grew) return
    entry.refinements += 1
    entry.signature = signature
    entry.at = now
    // Fire-and-forget like the service's own automatic generation: refinement
    // never delays the turn, and a failure only costs this one attempt.
    void Promise.resolve()
      .then(() => ctx.sessionTitle.refresh(session))
      .catch((error) => {
        state.lastError = {
          sessionId: session.id,
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        }
        ctx.logger?.warn?.(`session-namer: refinement failed for "${session.id}": ${String(error)}`)
      })
  })

  ctx.on('session/disposed', (session) => {
    state.titled.delete(session.id)
    state.hints.delete(session.id)
    state.manual.delete(session.id)
  })
  return undefined
}

/**
 * Re-title one live session on demand (tool and HTTP routes).
 *
 * `refresh()` is the only unpin path and the only way to regenerate a title for
 * a session that already has one; it is limited to sessions live in this
 * process, which is exactly the "explicit user action on the open session" scope
 * that was requested.
 *
 * @param ctx - context carrying `sessionTitle`.
 * @param state - the shared state record.
 * @param session - a session live in `ctx.sessions`.
 * @param hint - optional emphasis from the caller.
 * @returns `{ ok, title, previous, changed, source, model }`.
 */
async function regenerate(ctx, state, session, hint) {
  const titleService = ctx.get('sessionTitle')
  if (titleService === undefined) throw new Error('会话标题服务当前不可用')
  const before = titleService.get(session)
  if (hint !== undefined && hint !== '') state.hints.set(session.id, hint)
  state.manual.add(session.id)
  try {
    await titleService.refresh(session)
  } finally {
    state.manual.delete(session.id)
    state.hints.delete(session.id)
  }
  const after = titleService.get(session)
  return {
    ok: true,
    title: after?.title ?? null,
    previous: before?.title ?? null,
    changed: after?.title !== before?.title,
    source: after?.source?.kind ?? null,
    model: state.last?.sessionId === session.id ? state.last.model : null,
  }
}

/**
 * Register the HTTP routes that back the browser half.
 * @param ctx - context carrying `webServer` and `sessions`.
 * @param state - the shared state record.
 * @param config - normalized settings, echoed by `/status`.
 * @returns `undefined` — the registration is already an effect.
 */
function installRoutes(ctx, state, config) {
  const describeClient = () => {
    // `clientModules` is an optional service: a CLI-only profile has no browser
    // half at all. When it is present, `graph()` reports the composed boot graph,
    // which is the authoritative answer to "will the browser see my client.js".
    const clientModules = ctx.get?.('clientModules')
    if (clientModules === undefined) return { available: false }
    const graph = clientModules.graph?.()
    if (graph === undefined) return { available: false }
    const entry = graph.entries?.find?.((row) => row.id === name)
    return {
      available: true,
      composed: entry !== undefined,
      rev: graph.rev,
      entry: entry ?? null,
    }
  }
  const describe = () => ({
    ok: true,
    plugin: name,
    provider: PROVIDER_ID,
    automatic: 'first-prompt',
    revision: REVISION,
    config: {
      targetTitleWidth: config.targetTitleWidth,
      maxTitleWidth: config.maxTitleWidth,
      includeActivity: config.includeActivity,
      maxRefinements: config.maxRefinements,
      provider: config.provider === '' ? null : `${config.provider}/${config.model}`,
    },
    titledSessions: state.titled.size,
    last: state.last,
    error: state.lastError,
    client: describeClient(),
  })
  const routes = [
    { method: 'GET', path: `${ROUTE_PREFIX}/status`, mutation: false, handle: async () => describe() },
    {
      method: 'POST',
      path: `${ROUTE_PREFIX}/refresh`,
      mutation: true,
      handle: async (input) => {
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
        if (sessionId === '') throw new Error('缺少 sessionId')
        const session = ctx.sessions.get(sessionId)
        if (session === undefined) {
          throw new Error('该会话当前没有打开，无法重新取名；请先在 DSH 中打开它再试')
        }
        const hint = typeof input.hint === 'string' && input.hint.trim() !== '' ? input.hint.trim() : undefined
        const result = await regenerate(ctx, state, session, hint)
        return { ...result, status: describe() }
      },
    },
  ]

  const handleRoute = async (request, response) => {
    let url
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      sendJson(response, 400, { error: 'bad request' })
      return
    }
    const method = request.method ?? 'GET'
    const route = routes.find((candidate) => candidate.method === method && candidate.path === url.pathname)
    if (route === undefined) {
      sendJson(response, 404, { error: 'not found' })
      return
    }
    if (route.mutation && !sameOrigin(request)) {
      sendJson(response, 403, { error: '跨域请求被拒绝' })
      return
    }
    try {
      const input = route.mutation ? await readJson(request) : {}
      sendJson(response, 200, await route.handle(input))
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handleRoute })
  ctx.effect(() => dispose, 'dsh-session-namer: http routes')
  return undefined
}

/**
 * Register the `session_title` tool.
 *
 * Hand-written definition: `defineTool` lives in `@deepseek-ai/dsh-tools`, which
 * a profile install does not expose to a third-party plugin.
 *
 * @param ctx - context carrying `tools`.
 * @param state - the shared state record.
 * @returns `undefined` — the registration is already an effect.
 */
function installTool(ctx, state) {
  const tool = {
    name: TOOL_NAME,
    description:
      'Regenerate the title (name) of the session this tool runs in, from the human messages of that session. '
      + 'Use it when the current session title is generic, uninformative, or no longer matches what the session is '
      + 'about — for example a title like "Greeting" or "打招呼" left over from an opening hello. '
      + 'This only renames the session the tool runs in: it never touches other sessions and never rewrites session history. '
      + 'Pass `hint` to steer the wording.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hint: {
          type: 'string',
          description: 'Optional emphasis for the new title, e.g. "偏向工作区备份脚本" or "keep it under 6 CJK characters".',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          title: { type: 'string' },
          previous: { type: 'string' },
          changed: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok === true
            ? `会话名已更新为「${value.title}」（原为「${value.previous === undefined || value.previous === '' ? '无' : value.previous}」）`
            : `未能更新会话名：${value.message ?? '未知原因'}`,
        },
      ],
    },
    timeoutMs: 90000,
    isConcurrencySafe: () => false,
    /**
     * @param args - `{ hint? }`.
     * @param exec - tool execution context; `exec.agent.session` is the caller.
     * @returns the tool result object matching the declared output schema.
     */
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) {
        return { ok: false, message: '当前没有正在运行的会话上下文，无法为会话取名' }
      }
      const hint = typeof args?.hint === 'string' && args.hint.trim() !== '' ? args.hint.trim() : undefined
      try {
        const result = await regenerate(ctx, state, session, hint)
        return {
          ok: true,
          title: result.title ?? '',
          previous: result.previous ?? '',
          changed: result.changed === true,
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  const dispose = ctx.tools.register(tool)
  ctx.effect(() => dispose, 'dsh-session-namer: session_title tool')
  // `systemPrompt` is optional here: the tool schema alone makes the tool
  // callable, and the hint is only a nudge.
  ctx.get('systemPrompt')?.section?.({ name: 'tool:session_title', order: 113, text: TOOL_HINT })
  return undefined
}

/**
 * Plugin body.
 *
 * The three service groups are installed through separate `ctx.inject` calls so
 * that a missing optional service (a web server in a CLI-only profile) does not
 * stop the title provider from working. Each callback installs synchronously and
 * returns `undefined`, because a cordis inject callback is a plugin body and
 * `apply` return values are validated as effects.
 *
 * @param ctx - cordis context.
 * @param config - config object from the bundle patch layer.
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  const state = createState()

  ctx.inject(['sessionTitle', 'sessions', 'llm'], (serviceCtx) => {
    try {
      installProvider(serviceCtx, settings, state)
    } catch (error) {
      serviceCtx.logger?.warn?.(`session-namer: title provider unavailable: ${String(error)}`)
    }
    return undefined
  })

  ctx.inject(['webServer', 'sessions'], (routeCtx) => {
    try {
      installRoutes(routeCtx, state, settings)
    } catch (error) {
      routeCtx.logger?.warn?.(`session-namer: http routes unavailable: ${String(error)}`)
    }
    return undefined
  })

  ctx.inject(['tools'], (toolCtx) => {
    try {
      installTool(toolCtx, state)
    } catch (error) {
      toolCtx.logger?.warn?.(`session-namer: session_title tool unavailable: ${String(error)}`)
    }
    return undefined
  })
}
