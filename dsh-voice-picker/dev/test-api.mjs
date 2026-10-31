// 开发期一次性验证脚本：验证 qwen3-tts API 调用链（与 pet-service ttsQwen 同款逻辑）。
// 只读运行中的 pet 配置（GET /api/config），音频写到 %TEMP%，绝不写任何已有文件。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const voice = process.argv[2] || 'Moon'
const text = process.argv[3] || '你好呀，我是小鲸鱼，今天过得怎么样？'

const c = await (await fetch('http://127.0.0.1:18765/api/config')).json()
const origin = new URL(c.baseUrl).origin
console.log('[test] origin =', origin, '| voice =', voice)

const t0 = Date.now()
const r = await fetch(origin + '/api/v1/services/aigc/multimodal-generation/generation', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
  body: JSON.stringify({ model: 'qwen3-tts-flash', input: { text, voice }, parameters: {} }),
  signal: AbortSignal.timeout(20000),
})
const raw = await r.text()
if (!r.ok) { console.log('HTTP', r.status, raw.slice(0, 300)); process.exit(1) }
const j = JSON.parse(raw)
const url = j?.output?.audio?.url
if (!url) { console.log('无音频地址:', raw.slice(0, 300)); process.exit(1) }
const a = await fetch(url, { signal: AbortSignal.timeout(20000) })
const buf = Buffer.from(await a.arrayBuffer())
const out = path.join(os.tmpdir(), `vp-test-${voice}.wav`)
fs.writeFileSync(out, buf)
console.log('OK', `${Date.now() - t0}ms`, `${buf.length}B`,
  '头4字节:', buf.slice(0, 4).toString('ascii'),
  'RIFF?', buf.slice(0, 4).toString('ascii') === 'RIFF',
  '->', out)
