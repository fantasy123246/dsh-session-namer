# dsh-session-namer

更好的会话名。DSH 默认的会话标题 provider 只用**第一条**人类消息取名，而且它的
system prompt 里有一句 `still return a short best-effort title, such as Greeting`——
所以一个以「你好」开头的会话就永久叫「打招呼」「简单问候」「Greeting in Chinese」。

这个插件替换掉那个 provider，并额外提供两个手动入口（模型工具 + 界面按钮）。

## 它做什么

1. **替换标题 provider**。`automatic: 'first-prompt'`，但 prompt 完全不同：
   删掉 `such as Greeting`，改成「标题是列表里的路标，不是摘要」「以主语开头」
   「名词短语、2-4 个词」「禁止用问候类标签」`no "Greeting", "打招呼", "你好",
   "问候", "New chat", "闲聊", "简单问候"`，并把 **工作目录**、**agent preset**
   和 **会话实际做了什么** 一起喂给模型。
2. **喂「会话做了什么」而不只是「人说了什么」**。这是覆盖面问题的解：一条几千事件的
   长会话，人类消息加起来可能只有一两千字节，而 `tool/call` + `job/registered` 里
   藏着主语。digest 只取**工具名、文件名（basename）、脚本名**及其出现次数，
   不取任何工具输出、不取 assistant 正文，所以体积小（约 300 字节）且全是有信息的名词：
   ```json
   {"toolsUsed":["pwsh×166","read×89","write×74"],
    "filesTouched":["adapter.js×47","serialize.js×20","AGENTS.md×13"],
    "scriptsRun":["_probe_variant.mjs×10","_scan_logs.py×8"]}
   ```
   只出现一次的不带 `×1`。
3. **有界的自我修订**。一轮结束后，如果人类说了当前标题尚未引用的新内容，
   就 `sessionTitle.refresh()` 重跑一次（默认最多 4 次，两次之间至少隔 120 秒），
   让标题跟上实际工作。
   **只对本插件自己命名的会话生效**：装插件前就已有标题的会话不会进入这张表，
   而 `first-prompt` 语义上也不会让服务把「已有标题的会话」交给本插件
   ⇒ 历史会话名永远不会被改写。
4. **长度按显示宽度算，不是字数**。CJK 字符算 2 格、拉丁字母算 1 格，
   所以同一个预算下中文标题更短。超出上限时按边界截断：切在拉丁单词中间会退回词首，
   切在 CJK 串中间会退回最近的分隔符（否则会留下「产品 宣」这种半个词）。
5. **被拒的答案重来一次**。模型偶尔还是会返回「你好」（旧 prompt 教出来的习惯），
   或者超宽到必须截断。这两种情况会把拒稿理由追加进请求再问一次
   （**只对这两种硬失败**：略超目标宽度是正常的，不值得为它花第二次模型调用）。
6. **手动入口**（用户点了才跑）：
   - 模型工具 `session_title`：对话里说一句「给这个会话重新取个名字」即可。
   - 对话头部按钮「重新取名」：只作用于**当前打开**的会话。

## 不做什么

不批量修历史会话名，不改写任何已有的 `session.v4.jsonl.zstd`，不刷新投影缓存。
打开一个旧会话再点按钮属于显式用户动作，那一刻它是活会话，走的是
`sessionTitle.refresh()` —— 和自动流程无关。

## 安装

```powershell
# 把插件目录放到任意位置（例如 ~/.dsh/plugins/dsh-session-namer），然后：
dsh plugin --profile desktop add link:C:/Users/<you>/.dsh/plugins/dsh-session-namer
```

装完**完全退出 DSH（含托盘）再启动**。宿主半边在启动时注册 provider，
`cordis.patch.yml` 里 `session-title-llm: disabled` 会同时生效。

改完 `lib/index.js` 想立刻生效：宿主有 `dsh-hmr` 在盯着插件目录，`touch` 一下文件等几秒即可，
`GET /dsh-session-namer/status` 的 `revision` 字段会变成源码里的 `REVISION` 常量。

## 配置

在插件自己的 `cordis.patch.yml` 里 `config:` 段（或在 profile 的 `cordis.patch.yml`
覆盖同名条目）。**全部可选**：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `targetTitleWidth` | `16` | 目标显示宽度（格）；CJK 字符 2 格、拉丁字母 1 格，即 8 个汉字或 16 个字母 |
| `maxTitleWidth` | `24` | 硬上限；超出按边界截断 |
| `maxInputBytes` | `8192` | 送给模型的输入字节上限（超了从最旧的消息开始丢） |
| `maxOutputTokens` | `1024` | 输出上限；推理模型会先花 token 思考 |
| `timeoutMs` | `45000` | 单次取名超时 |
| `maxRefinements` | `4` | 自驱动修订上限；`0` = 只取一次名，之后不再自动改 |
| `refineGapMs` | `120000` | 同一会话两次修订之间的最小间隔，防止连着几个短回合就刷一串模型调用 |
| `includeCwd` | `true` | 是否把工作目录作为主语素材 |
| `includeActivity` | `true` | 是否把「会话做了什么」的 digest 一起发 |
| `provider` / `model` | 空 | 显式路由覆盖，两个必须同时给；留空则用会话已记录的 route |

## 手动入口的行为

- 工具：`exec.agent.session` → `sessionTitle.refresh()`，返回
  `{ok, title, previous, changed}`；失败返回 `{ok: false, message}`，不会抛到模型。
- 按钮：`POST /dsh-session-namer/refresh` `{sessionId, hint?}`，返回
  `{ok, title, previous, changed, source, model, status}`。
  `GET /dsh-session-namer/status` 看 `revision`、生效配置、最近一次生成结果与失败原因。
  会话不在内存里时返回 400「该会话当前没有打开」——不碰冷会话。
- `hint` 可以给一句话强调，例如 `偏向备份脚本`。

## 测试

```bash
node tests/smoke.mjs          # 端到端，全部 stub，不联网
node tests/clamp.mjs          # 截断行为
node tests/replay.mjs <plain.jsonl>   # 回放真实会话日志，打印实际会发出的 prompt
node tests/eval.mjs <out.json> <plain.jsonl>...  # 批量导出 prompt
```

`session.v4.jsonl.zstd` 是**多帧** zstd，node 的 `zstdDecompressSync` 只解第一帧会截断，
所以 `tests/unpack.py` 用 Python 的 `zstandard.stream_reader` 走完全部帧。

## 为什么不能 import `@deepseek-ai/*`

profile 安装不会把官方包交给三方插件（`profiles/<name>/node_modules/@deepseek-ai`
里只有 `cosmokit` 和 `schemastery`）。所以宿主半边只用 node 内建模块，工具定义手写，
LLM 流自己累加（只认 `text-delta` 与 `finish`）。

## 已知边界

- `sessionTitle` 同时只允许一个 provider；装本插件必须让
  `session-title-llm` 保持 `disabled`，否则服务会报
  `session-title provider "..." is already registered`。
- 会话若被用户手动改过名（`source.kind === 'user'`），refinement 会立刻放弃该会话，
  只有显式点按钮/调工具才会覆盖——这是刻意的。
- `refresh()` 只对内存中的活会话可用（`session "${id}" is not live in this store`）。

## License

MIT
