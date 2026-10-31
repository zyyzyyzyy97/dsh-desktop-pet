#!/usr/bin/env node
/**
 * qq-bridge.mjs — 让鲸鱼住进 QQ。
 *
 * 走 OneBot 11（NapCat / LLOneBot 都认这一套）：
 *   收消息 → 有图就把图取下来 → 丢给 pet-service 的 /api/chat/say
 *   → 拿到她用自己人设说的话 → send_msg 发回去
 *
 * 是独立进程，崩了不影响桌面上的鱼。
 *
 *   node vendor/qq-bridge.mjs            # 按 qq-config.json 跑
 *   node vendor/qq-bridge.mjs --once     # 只连一次，打印收到的第一条消息就退出
 *
 * 配置在同目录的 qq-config.json，首次运行会自动生成一份。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CFG_FILE = path.join(ROOT, 'qq-config.json')
const LOG_FILE = process.env.QQ_LOG_FILE
  ? path.resolve(process.env.QQ_LOG_FILE)
  : path.join(ROOT, 'qq-bridge.log')
const ONCE = process.argv.includes('--once')

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.map(String).join(' ')}\n`
  try { fs.appendFileSync(LOG_FILE, line) } catch { /* noop */ }
  process.stdout.write(line)
}

/* ------------------------------------------------------------------ *
 * 单实例锁：两个桥同时连着 NapCat，每条消息会回两遍，所以只留一个
 * ------------------------------------------------------------------ */
const LOCK_FILE = path.join(ROOT, 'qq-bridge.lock')
if (!ONCE) {
  let alive = false
  try {
    const oldPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
    if (oldPid > 0 && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0)
        alive = true
      } catch {
        alive = false
      }
    }
  } catch {
    /* 锁文件不存在，正常往下走 */
  }
  if (alive) {
    process.stdout.write(`[qq-bridge] 已经有一个桥在跑了，这个直接退出\n`)
    process.exit(0)
  }
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid))
  } catch {
    /* noop */
  }
  const dropLock = () => {
    try {
      if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE)
    } catch {
      /* noop */
    }
  }
  process.on('exit', dropLock)
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      dropLock()
      process.exit(0)
    })
  }
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  enabled: false,
  /** forward = 我们连 NapCat（NapCat WebUI 里开「WebSocket 服务器」） */
  mode: 'forward',
  wsUrl: 'ws://127.0.0.1:3001',
  /** 反向模式时我们监听的端口，NapCat 那边填 ws://127.0.0.1:<这个>/onebot/v11/ws */
  listenPort: 18767,
  path: '/onebot/v11/ws',
  token: '',
  /** 鲸鱼那边 */
  petApi: 'http://127.0.0.1:18765',
  /** 自己的 QQ 号，用来忽略自己发的消息；留 0 就靠 NapCat 的 self_id 判断 */
  selfId: 0,
  privateReply: true,
  groupReply: true,
  /** 群里只在 @ 她 或喊她名字时才回，免得刷屏 */
  groupAtOnly: true,
  /** 喊她名字也算叫她（群里不 @ 但直接叫） */
  aliases: ['小女子', '肥鱼', '小鲸鱼', 'Coo', 'coo'],
  /** 白名单：群号/QQ 号。空数组 = 不限制 */
  allow: [],
  /** 一条消息最多回多少字，超了截断（她自己本来就说得短） */
  maxReplyChars: 300,
  /** 同一会话两次回复的最小间隔（毫秒），防刷屏 */
  cooldownMs: 1500,
  /** 她挑了表情包就跟着发过去 */
  sendMeme: true,
  /** 把她的回复当 QQ 语音再发一条（文字照发，语音是补充） */
  sendVoice: true,
  /**
   * 只发语音：有语音就只发语音（表情包照带），一个字都不打。
   * 只有语音合成失败才退回发字 —— 否则他什么都收不到。
   */
  voiceOnly: false,
}

function readCfg() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

let cfg = readCfg()
// 测试时用环境变量覆盖，别动真实配置
if (process.env.QQ_ENABLED === '1') cfg.enabled = true
if (process.env.QQ_WS_URL) cfg.wsUrl = process.env.QQ_WS_URL
if (process.env.QQ_TOKEN) cfg.token = process.env.QQ_TOKEN
if (process.env.QQ_PET_API) cfg.petApi = process.env.QQ_PET_API
if (process.env.QQ_SELF_ID) cfg.selfId = Number(process.env.QQ_SELF_ID)
if (process.env.QQ_VOICE_ONLY) cfg.voiceOnly = process.env.QQ_VOICE_ONLY === '1'

if (!fs.existsSync(CFG_FILE)) {
  try {
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    log('[qq] 已生成默认配置 qq-config.json，改好 wsUrl / token 再启动')
  } catch (e) { log('[qq] 配置写入失败', e.message) }
}

/* ------------------------------------------------------------------ *
 * 消息归一化
 * ------------------------------------------------------------------ */

/** OneBot 的 message 可能是数组（Array 格式）也可能是一串 CQ 码，这里统一成数组。 */
function segments(ev) {
  if (Array.isArray(ev.message)) return ev.message
  const raw = String(ev.raw_message || ev.message || '')
  const out = []
  const re = /\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g
  let last = 0
  let m
  while ((m = re.exec(raw))) {
    if (m.index > last) out.push({ type: 'text', data: { text: raw.slice(last, m.index) } })
    const data = {}
    for (const kv of m[2].split(',').filter(Boolean)) {
      const i = kv.indexOf('=')
      if (i > 0) data[kv.slice(0, i)] = kv.slice(i + 1)
    }
    out.push({ type: m[1], data })
    last = m.index + m[0].length
  }
  if (last < raw.length) out.push({ type: 'text', data: { text: raw.slice(last) } })
  return out
}

function unescapeCQ(s) {
  return String(s).replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&')
}

/**
 * 把一条事件拆成：说了什么、带了哪些图、是不是在叫她。
 */
function parse(ev, cfg) {
  const segs = segments(ev)
  let text = ''
  const images = []
  let atMe = false
  let voice = null
  const selfId = String(cfg.selfId || ev.self_id || '')

  for (const s of segs) {
    const d = s.data || {}
    if (s.type === 'text') text += unescapeCQ(d.text || '')
    else if (s.type === 'image') {
      // url 优先（NapCat 会给临时地址），退回本地 file 路径
      const u = d.url || d.file || ''
      if (u) images.push(String(u))
    } else if (s.type === 'record') {
      // 她的耳朵只认 16k wav，QQ 语音是 silk/amr，这里先只记下来
      voice = String(d.url || d.file || '')
    } else if (s.type === 'at') {
      if (String(d.qq) === selfId) atMe = true
    } else if (s.type === 'face') {
      /* 小黄脸表情，忽略 */
    }
  }

  text = text.replace(/\s+/g, ' ').trim()
  const called = cfg.aliases.some((a) => text.includes(a))
  return { text, images, atMe, called, selfId, voice }
}

/* ------------------------------------------------------------------ *
 * 调鲸鱼
 * ------------------------------------------------------------------ */

let seq = 0
/** 连续失败次数：决定日志要不要出声 */
let failCount = 0

async function askPet(text, images) {
  const body = { text, channel: 'qq' }
  if (images.length) body.images = images.slice(0, 4)
  const r = await fetch(`${cfg.petApi.replace(/\/+$/, '')}/api/chat/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.ok) throw new Error(j.error || `pet api HTTP ${r.status}`)
  return {
    text: String(j.reply || ''),
    reply: String(j.reply || ''),
    usedImages: j.images || 0,
    ms: j.ms || 0,
    meme: j.meme || null,
    audio: j.audio || null,
  }
}

/* ------------------------------------------------------------------ *
 * 发送
 * ------------------------------------------------------------------ */

function send(ws, action, params) {
  const echo = `b${++seq}`
  ws.send(JSON.stringify({ action, params, echo }))
}

/** 往哪个会话里扔消息 */
function target(ev) {
  return ev.message_type === 'group'
    ? { action: 'send_group_msg', params: { group_id: ev.group_id } }
    : { action: 'send_private_msg', params: { user_id: ev.user_id } }
}

/** 把鲸鱼服务上的图 / mp3 取下来，转成 OneBot 认的 base64:// —— 绕开路径编码那堆坑 */
async function fetchB64(url) {
  const full = /^https?:/i.test(url) ? url : cfg.petApi.replace(/\/+$/, '') + url
  const r = await fetch(full, { signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 100) throw new Error('文件太小')
  return 'base64://' + buf.toString('base64')
}

/**
 * 默认：先发字，再发图，最后发语音。
 * 分开发是故意的：万一 QQ 那边不认表情包或语音格式，字已经送到了，
 * 不会因为配菜失败把正餐一起丢了。
 *
 * voiceOnly：先把语音取下来，取到了就只发语音（表情包照带），一个字都不发；
 * 取不到才退回「发字」，保证他不会对着空白等。
 */
async function sendReply(ws, ev, out) {
  const raw = String(out.text || '')
  const cut = raw.length > cfg.maxReplyChars ? raw.slice(0, cfg.maxReplyChars) + '…' : raw
  const t = target(ev)

  // 语音先取：它成不成，决定只发语音模式下还发不发字
  let voiceFile = null
  if (cfg.sendVoice && out.audio) {
    try {
      voiceFile = await fetchB64(out.audio)
    } catch (e) {
      log('[qq] 语音没发出去', e.message)
    }
  }

  if (cfg.voiceOnly) {
    if (voiceFile) {
      send(ws, t.action, { ...t.params, message: [{ type: 'record', data: { file: voiceFile } }] })
      if (cfg.sendMeme && out.meme) {
        try {
          send(ws, t.action, {
            ...t.params,
            message: [{ type: 'image', data: { file: await fetchB64(out.meme) } }],
          })
        } catch (e) {
          log('[qq] 表情包没发出去', e.message)
        }
      }
      return
    }
    log('[qq] 只发语音模式，但这次没合成出语音，退回发字')
  }

  const message = [{ type: 'text', data: { text: cut } }]
  if (cfg.sendMeme && out.meme) {
    try {
      message.push({ type: 'image', data: { file: await fetchB64(out.meme) } })
    } catch (e) {
      log('[qq] 表情包没发出去', e.message)
    }
  }
  send(ws, t.action, { ...t.params, message })

  if (voiceFile) {
    send(ws, t.action, { ...t.params, message: [{ type: 'record', data: { file: voiceFile } }] })
  }
}

/* ------------------------------------------------------------------ *
 * 处理一条事件
 * ------------------------------------------------------------------ */

const lastReplyAt = new Map()

async function handle(ws, ev) {
  if (ev.post_type !== 'message') return
  const selfId = String(cfg.selfId || ev.self_id || '')
  if (String(ev.user_id) === selfId) return                       // 自己说的不听
  if (ev.message_type === 'private' && !cfg.privateReply) return
  if (ev.message_type === 'group' && !cfg.groupReply) return

  if (cfg.allow.length) {
    const key = String(ev.group_id || ev.user_id)
    if (!cfg.allow.includes(key)) return
  }

  const { text, images, atMe, called, voice } = parse(ev, { ...cfg, selfId })

  if (ev.message_type === 'group' && cfg.groupAtOnly && !atMe && !called) return
  if (!text && !images.length) {
    if (voice) {
      const t = target(ev)
      send(ws, t.action, {
        ...t.params,
        message: [{ type: 'text', data: { text: 'QQ 语音我这边还听不了，你打字或者发表情给我嘛～' } }],
      })
    }
    return
  }

  // 防刷屏：同一会话冷却
  const conv = String(ev.group_id || ev.user_id)
  const now = Date.now()
  if (now - (lastReplyAt.get(conv) || 0) < cfg.cooldownMs) return
  lastReplyAt.set(conv, now)

  log('[qq] 收到', ev.message_type, conv, '|', text.slice(0, 60), images.length ? `+${images.length}图` : '')

  try {
    const out = await askPet(text, images)
    if (!out.reply) { log('[qq] 鱼没说话'); return }
    log(
      '[qq] 回复', `${out.ms}ms`, `图=${out.usedImages}`,
      out.meme ? '带表情包' : '', out.audio ? '带语音' : '',
      '|', out.reply.slice(0, 60),
    )
    await sendReply(ws, ev, out)
  } catch (e) {
    log('[qq] 出错', e.message)
  }
}

/* ------------------------------------------------------------------ *
 * 连接
 * ------------------------------------------------------------------ */

function connectForward() {
  const url = cfg.wsUrl
  if (!failCount) log('[qq] 连', url)
  const headers = cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}
  const ws = new WebSocket(url, { headers })

  ws.on('open', () => {
    failCount = 0
    log('[qq] 已连上 NapCat（forward）')
  })
  ws.on('message', (raw) => {
    let ev
    try { ev = JSON.parse(String(raw)) } catch { return }
    if (ev.post_type === 'meta_event') return
    if (ONCE && ev.post_type === 'message') {
      log('[qq] --once 收到第一条消息，退出')
      void handle(ws, ev)
      setTimeout(() => process.exit(0), 15000)
      return
    }
    void handle(ws, ev)
  })
  ws.on('close', (code, why) => {
    failCount++
    // 没登录时每 5 秒重连一次，别把日志刷满：只报第 1 次、之后每 20 次报一行
    if (failCount === 1 || failCount % 20 === 0) {
      log('[qq] 断开', code, String(why || ''), `（第 ${failCount} 次，5 秒后重连）`)
    }
    setTimeout(connectForward, 5000)
  })
  ws.on('error', (e) => {
    failCount++
    if (failCount === 1 || failCount % 20 === 0) log('[qq] ws 错误', e.message)
  })
}

async function connectReverse() {
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ port: cfg.listenPort, path: cfg.path })
  log('[qq] 反向模式监听', `ws://127.0.0.1:${cfg.listenPort}${cfg.path}`)
  wss.on('connection', (ws, req) => {
    const auth = String(req.headers.authorization || '')
    if (cfg.token && auth !== `Bearer ${cfg.token}` && auth !== `Token ${cfg.token}`) {
      log('[qq] 鉴权失败，拒绝连接')
      ws.close(1008, 'bad token')
      return
    }
    log('[qq] NapCat 已连入（reverse）')
    ws.on('message', (raw) => {
      let ev
      try { ev = JSON.parse(String(raw)) } catch { return }
      if (ev.post_type === 'meta_event') return
      void handle(ws, ev)
    })
    ws.on('close', () => log('[qq] 反向连接断开'))
  })
}

if (!cfg.enabled && !ONCE) {
  log('[qq] qq-config.json 里 enabled 还是 false，先改好再启动')
  process.exit(0)
}

log('[qq] 配置', JSON.stringify({ mode: cfg.mode, wsUrl: cfg.wsUrl, listenPort: cfg.listenPort, petApi: cfg.petApi }))
if (cfg.mode === 'reverse') void connectReverse()
else connectForward()
