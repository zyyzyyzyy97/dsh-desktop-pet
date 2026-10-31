/**
 * try-send-voice.mjs — 用 NapCat 的 API 直接把一段 wav 当语音发给某个号。
 *
 * 只为一件事：验证「只发语音模式」最不确定的一环 ——
 * NapCat 认不认 `record` + `base64://` 的 24k wav。
 * 桥里发语音用的就是这一套，这里只是绕开桥直接试。
 *
 *   node test/try-send-voice.mjs <对方QQ号> [wav路径]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = Number(process.argv[2] || 0)
const WAV = process.argv[3] || path.join(ROOT, 'runtime-data', 'voice', 'f79bbe05c9478581.wav')

if (!TARGET) { console.error('缺目标 QQ 号'); process.exit(1) }
if (!fs.existsSync(WAV)) { console.error('找不到 wav:', WAV); process.exit(1) }
const buf = fs.readFileSync(WAV)
console.log('发这个文件:', path.basename(WAV), buf.length, 'B →', TARGET)

const ws = new WebSocket('ws://127.0.0.1:3001')
let id = 0
const waits = new Map()
ws.on('message', (r) => {
  let m
  try { m = JSON.parse(String(r)) } catch { return }
  if (m.echo && waits.has(m.echo)) { waits.get(m.echo)(m); waits.delete(m.echo) }
})
const call = (action, params = {}) => new Promise((res) => {
  const echo = 'v' + (++id)
  waits.set(echo, res)
  ws.send(JSON.stringify({ action, params, echo }))
  setTimeout(() => { if (waits.has(echo)) { waits.delete(echo); res({ timeout: true }) } }, 30000)
})

await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })

// 先按桥里一样的方式发
const b64 = 'base64://' + buf.toString('base64')
let r = await call('send_private_msg', { user_id: TARGET, message: [{ type: 'record', data: { file: b64 } }] })
console.log('record + base64 结果:', JSON.stringify(r).slice(0, 300))

// 万一不认，再退回本地路径（NapCat 的 enableLocalFile2Url）
if (r.status !== 'ok' || r.retcode !== 0) {
  r = await call('send_private_msg', { user_id: TARGET, message: [{ type: 'record', data: { file: 'file:///' + WAV.replace(/\\/g, '/') } }] })
  console.log('record + 本地路径 结果:', JSON.stringify(r).slice(0, 300))
}

ws.close()
process.exit(0)
