#!/usr/bin/env node
/**
 * check-voice-meme.mjs — 验证页面上真能收到「语音」和「表情包」这两条推送。
 *
 * 不截图、不改 DOM，只按真实页面的方式连上 /socket，然后从外部触发一句对话，
 * 看服务端到底有没有把 say / meme / voice 三条消息发出来。
 *
 *   node test/check-voice-meme.mjs 18901 "我饿了"
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.argv[2] || 18765)
const LINE = process.argv[3] || '我饿了，今天好累'

const key = (() => {
  const log = fs.readFileSync(path.join(ROOT, 'pet-service.log'), 'utf8')
  const hits = [...log.matchAll(/窗口地址: http:\/\/127\.0\.0\.1:(\d+)\/pet#key=([0-9a-f-]+)/g)]
  const mine = hits.filter((m) => Number(m[1]) === PORT).pop()
  return mine ? mine[2] : ''
})()

if (!key) {
  console.error('没在日志里找到端口', PORT, '的页面 key')
  process.exit(1)
}

const got = { say: [], meme: [], voice: [] }
// role=pet 才会被服务端当成「那条鱼本人的页面」，否则只是一个旁观标签页
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket?role=pet&host=tab&key=${key}`)

ws.on('open', async () => {
  ws.send(JSON.stringify({ t: 'hello', screen: { w: 380, h: 420 }, host: 'tab' }))
  console.log('已连上 /socket，触发一句：', LINE)
  const r = await fetch(`http://127.0.0.1:${PORT}/api/chat/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: LINE, screen: false }),
  })
  const j = await r.json()
  console.log('接口返回：', JSON.stringify({ reply: j.reply?.slice(0, 40), meme: j.meme, audio: j.audio, ms: j.ms }))
})

ws.on('message', (raw) => {
  let m
  try { m = JSON.parse(String(raw)) } catch { return }
  if (m.t === 'say') {
    got.say.push((m.beats || []).map((b) => b.text).join(''))
  } else if (m.t === 'meme') {
    got.meme.push(m.url)
  } else if (m.t === 'voice') {
    got.voice.push(m.url)
  }
})

setTimeout(async () => {
  const ok = got.say.length > 0 && got.voice.length > 0
  console.log('\n收到 say :', got.say.length, got.say[0]?.slice(0, 40) || '')
  console.log('收到 meme:', got.meme.length, got.meme[0] || '')
  console.log('收到 voice:', got.voice.length, got.voice[0] || '')
  // 语音文件真的能取到吗
  if (got.voice[0]) {
    const r = await fetch(`http://127.0.0.1:${PORT}${got.voice[0]}`)
    const buf = Buffer.from(await r.arrayBuffer())
    console.log('语音可下载:', r.status, r.headers.get('content-type'), buf.length + 'B')
  }
  console.log(ok ? '\n通过：文字 + 语音都推到页面了' : '\n失败：没收到语音')
  ws.close()
  process.exit(ok ? 0 : 1)
}, 12000)
