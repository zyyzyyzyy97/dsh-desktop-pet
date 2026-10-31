/**
 * watch-onebot.mjs — 盯住 NapCat 的 OneBot WS，把收到的事件原样记下来。
 * 用来分清：消息根本没推过来，还是推过来了但桥把它吃了。
 *
 *   node test/watch-onebot.mjs [秒数] [日志文件]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SECONDS = Number(process.argv[2] || 300)
const OUT = process.argv[3] || path.join(ROOT, 'runtime-data', 'onebot-watch.log')

fs.writeFileSync(OUT, '')
const log = (s) => {
  const line = `[${new Date().toISOString()}] ${s}\n`
  fs.appendFileSync(OUT, line)
  process.stdout.write(line)
}

const ws = new WebSocket('ws://127.0.0.1:3001')
ws.on('open', () => log('已连上 NapCat WS'))
ws.on('error', (e) => log('ws 错误 ' + e.message))
ws.on('message', (raw) => {
  let m
  try { m = JSON.parse(String(raw)) } catch { return }
  if (m.post_type === 'meta_event') return
  // 一行一条，把关键字段全留下
  log(JSON.stringify({
    post: m.post_type,
    type: m.message_type || m.notice_type || '',
    self: m.self_id,
    user: m.user_id,
    group: m.group_id,
    raw: String(m.raw_message || '').slice(0, 80),
    msg: Array.isArray(m.message) ? m.message.map((s) => s.type).join('+') : typeof m.message,
  }))
})
ws.on('close', () => log('WS 断开'))

log(`开始监听 ${SECONDS} 秒，事件写到 ${OUT}`)
setTimeout(() => { ws.close(); log('监听结束'); process.exit(0) }, SECONDS * 1000)
