/**
 * dsh-voice-picker 服务端（无第三方依赖，纯 node）。
 *
 * 职责：
 *   1. 托管音色工作台页面（web/index.html）；
 *   2. GET /api/voices   —— 48 音色 + 小鲸鱼当前音色（密钥绝不下发到页面）；
 *   3. POST /api/preview —— 指定音色试听：服务端拿 key 调 qwen3-tts-flash，音频缓存后回传；
 *   4. POST /api/apply   —— 切音色：转发到小鲸鱼自己的 POST /api/config（pet-service 内部
 *      writeCfg 会同步内存 + 落盘），随后经控制端口让鲸鱼用新声音说一句确认。热生效，
 *      无需重启 DSH。本插件从不直接改任何文件。
 *
 * 密钥来源（只读，绝不写出）：优先运行中的小鲸鱼 GET /api/config；
 * 离线时只读兄弟插件目录的 dsh-desktop-pet/pet-config.json（预览仍可用，切换不行）。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const VOICES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'voices.json'), 'utf8')).voices
const INDEX_HTML = path.join(ROOT, 'web', 'index.html')

/** 试听示例句（可被页面覆盖） */
export const DEFAULT_PREVIEW_TEXT = '你好呀，我是小鲸鱼，今天想聊点什么？'

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function startPickerServer(opts = {}) {
  const {
    port = 18768,
    petPort = 18765,
    ctrlPort = 18766,
    autoOpen = false,
    log = console.log,
  } = opts

  /** `${voice}|${text}` -> Buffer（LRU 简化版） */
  const previewCache = new Map()

  function petConfigPath() {
    // 安装后本插件与 dsh-desktop-pet 是 plugins/ 下的兄弟目录
    return path.join(ROOT, '..', 'dsh-desktop-pet', 'pet-config.json')
  }

  async function readPetConfig() {
    try {
      const r = await fetch(`http://127.0.0.1:${petPort}/api/config`, { signal: AbortSignal.timeout(2500) })
      if (r.ok) return { ...(await r.json()), _online: true }
    } catch { /* pet 离线，走文件兜底 */ }
    try {
      return { ...JSON.parse(fs.readFileSync(petConfigPath(), 'utf8')), _online: false }
    } catch {
      return null
    }
  }

  /** 与 pet-service.ts 的 ttsQwen 同款调用：DashScope 原生协议，返回音频 Buffer（24k 单声道 WAV） */
  async function qwenTts(text, voice) {
    const c = await readPetConfig()
    if (!c?.apiKey) throw new Error('没有拿到 API Key（小鲸鱼未运行，也找不到 pet-config.json）')
    const origin = new URL(c.baseUrl || 'https://dashscope.aliyuncs.com').origin
    const r = await fetch(origin + '/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ model: 'qwen3-tts-flash', input: { text, voice }, parameters: {} }),
      signal: AbortSignal.timeout(20000),
    })
    const raw = await r.text()
    if (!r.ok) throw new Error(`TTS HTTP ${r.status} ${raw.slice(0, 120)}`)
    let j = null
    try { j = JSON.parse(raw) } catch { /* fallthrough */ }
    const url = j?.output?.audio?.url
    if (!url) throw new Error('TTS 没有返回音频地址: ' + raw.slice(0, 120))
    const a = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!a.ok) throw new Error(`音频下载 HTTP ${a.status}`)
    const buf = Buffer.from(await a.arrayBuffer())
    if (buf.length < 1000) throw new Error('音频太小，疑似失败')
    return buf
  }

  /** VP_FAKE_TTS=1 时的测试钩子：返回一个 8kHz 1 秒静音 WAV，离线可测全链路 */
  function fakeTts() {
    const sr = 8000
    const n = sr
    const b = Buffer.alloc(44 + n * 2)
    b.write('RIFF', 0)
    b.writeUInt32LE(36 + n * 2, 4)
    b.write('WAVE', 8)
    b.write('fmt ', 12)
    b.writeUInt32LE(16, 16)
    b.writeUInt16LE(1, 20)
    b.writeUInt16LE(1, 22)
    b.writeUInt32LE(sr, 24)
    b.writeUInt32LE(sr * 2, 28)
    b.writeUInt16LE(2, 32)
    b.writeUInt16LE(16, 34)
    b.write('data', 36)
    b.writeUInt32LE(n * 2, 40)
    return b
  }

  function sendJson(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  const handler = async (req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const p = u.pathname

      /* ---- 页面（每次读盘：本地文件极小，且避免改动后要重启才能看到） ---- */
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(INDEX_HTML)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(html)
      }

      /* ---- 音色列表 + 当前音色（不含密钥） ---- */
      if (req.method === 'GET' && p === '/api/voices') {
        const cfg = await readPetConfig()
        return sendJson(res, 200, {
          ok: true,
          count: VOICES.length,
          voices: VOICES,
          current: cfg?.ttsVoice || null,
          petOnline: !!cfg?._online,
          petName: cfg?.name || null,
          hasKey: !!cfg?.apiKey,
        })
      }

      /* ---- 一键切换（经小鲸鱼自己的 /api/config 热生效） ---- */
      if (req.method === 'POST' && p === '/api/apply') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const voice = String(body.voice || '').trim()
        if (!/^[A-Za-z0-9 .·\-]{1,40}$/.test(voice)) {
          return sendJson(res, 400, { ok: false, error: `音色 id 不合法: ${voice}` })
        }
        let r
        try {
          r = await fetch(`http://127.0.0.1:${petPort}/api/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ttsVoice: voice }),
            signal: AbortSignal.timeout(5000),
          })
        } catch {
          return sendJson(res, 502, { ok: false, error: '小鲸鱼没在线（先启动 DSH），没法热切换。' })
        }
        const j = await r.json().catch(() => ({}))
        if (!r.ok || !j.ok) {
          return sendJson(res, 502, { ok: false, error: `小鲸鱼拒绝了请求(HTTP ${r.status}): ${j.error || JSON.stringify(j).slice(0, 120)}` })
        }
        // 用新声音让鲸鱼本人说一句（best-effort，失败不影响切换结果）
        let said = false
        if (body.confirm !== false) {
          try {
            const c = await fetch(`http://127.0.0.1:${ctrlPort}/control`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'say', text: '喂喂——听得到吗？我换新声音啦。' }),
              signal: AbortSignal.timeout(4000),
            })
            said = c.ok
          } catch { /* 鲸鱼窗口可能没开 */ }
        }
        log('[picker] 已切换音色 ->', voice, said ? '(已让鲸鱼开口确认)' : '')
        return sendJson(res, 200, { ok: true, current: voice, said })
      }

      /* ---- 试听（服务端持 key 合成，页面拿不到密钥） ---- */
      if (req.method === 'POST' && p === '/api/preview') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const voice = String(body.voice || '').trim()
        const text = String(body.text || DEFAULT_PREVIEW_TEXT).trim().slice(0, 120)
        if (!/^[A-Za-z0-9 .·\-]{1,40}$/.test(voice)) {
          return sendJson(res, 400, { ok: false, error: `音色 id 不合法: ${voice}` })
        }
        if (!text) return sendJson(res, 400, { ok: false, error: '试听文本是空的' })
        const key = `${voice}|${text}`
        let buf = previewCache.get(key)
        if (!buf) {
          if (process.env.VP_FAKE_TTS === '1') buf = fakeTts()
          else buf = await qwenTts(text, voice)
          if (previewCache.size >= 160) {
            previewCache.delete(previewCache.keys().next().value)
          }
          previewCache.set(key, buf)
          log('[picker] 试听合成', voice, `${text.length}字`, `${buf.length}B`)
        }
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
        return res.end(buf)
      }

      sendJson(res, 404, { ok: false, error: `not found: ${p}` })
    } catch (e) {
      log('[picker] 请求处理失败:', String((e && e.message) || e))
      try { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }) } catch { /* noop */ }
    }
  }

  async function listenOnce(attempt) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(handler)
      s.once('error', reject)
      s.listen(port + attempt, '127.0.0.1', () => resolve(s))
    })
  }

  // 端口冲突自动 +1 重试（最多 5 次），实际端口以返回值为准
  let server = null
  let actual = port
  for (let i = 0; i < 6; i++) {
    try {
      server = await listenOnce(i)
      actual = port + i
      break
    } catch (e) {
      if (e?.code !== 'EADDRINUSE') throw e
      log('[picker] 端口', port + i, '被占用，换下一个')
    }
  }
  if (!server) throw new Error(`${port}-${port + 5} 全被占用，起不来`)

  const url = `http://127.0.0.1:${actual}/`
  log('[picker] 音色工作台已启动:', url, `(${VOICES.length} 音色)`)
  if (autoOpen) {
    try { exec(`start "" "${url}"`, { shell: 'cmd.exe' }) } catch { /* noop */ }
  }

  return {
    port: actual,
    url,
    close: () => { try { server.close() } catch { /* noop */ } },
  }
}
