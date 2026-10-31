#!/usr/bin/env node
/**
 * check-voiceonly.mjs — 验证 QQ 桥「只发语音」模式真的一个字都不打。
 *
 * 不碰真 QQ、不碰真配置：起一个假 pet 接口 + 一个假 NapCat（OneBot 11 WS），
 * 用 --once 跑真实的 vendor/qq-bridge.mjs，只看它往 WS 里发出来的是什么。
 *
 *   node test/check-voiceonly.mjs
 *
 * 三个场景：
 *   1. voiceOnly + 有语音      → 只发 record（表情包照带），一条 text 都不许有
 *   2. voiceOnly + 没合成出语音 → 退回发 text，不能让他干等
 *   3. 老行为（voiceOnly 关）   → 仍然先 text 再 record
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = path.join(ROOT, 'vendor', 'qq-bridge.mjs')
const SELF_ID = 900000001

// fetchB64 会把 <100 字节的响应当「文件太小」拒掉，所以夹具要够大
const PNG = Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
  Buffer.alloc(256),
])
const WAV = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WAVEfmt '),
  Buffer.alloc(1024),
])

const EVENT = {
  post_type: 'message',
  message_type: 'private',
  self_id: SELF_ID,
  user_id: 123456,
  time: Math.floor(Date.now() / 1000),
  message: [{ type: 'text', data: { text: '在吗' } }],
  raw_message: '在吗',
  sender: { user_id: 123456, nickname: '测试' },
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 假 pet-service：一个 /api/chat/say，外加两个能取下来的静态文件 */
function fakePet(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (req.method === 'POST' && url.pathname === '/api/chat/say') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const j = JSON.parse(body || '{}')
        const wantAudio = !j.text || !j.text.includes('没声音')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          reply: '嗯，我在呢，刚把尾巴收起来。',
          meme: '/meme/x.png',
          audio: wantAudio ? '/voice/x.wav' : null,
          images: 0,
          ms: 900,
        }))
      })
      return
    }
    if (url.pathname === '/meme/x.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
      return
    }
    if (url.pathname === '/voice/x.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav' })
      res.end(WAV)
      return
    }
    res.writeHead(404).end()
  })
  return server
}

/**
 * 跑一个场景：起服务 → 起桥 → 灌一条消息 → 收它发出来的动作。
 * 每段占一对独立端口，免得上一轮的连接卡住下一轮。
 */
async function runCase({ name, voiceOnly, text, wantVoice, petPort, wsPort }) {
  const got = []
  const pet = fakePet(petPort)
  await listen(pet, petPort)

  const wss = new WebSocketServer({ port: wsPort })
  await new Promise((r) => wss.once('listening', r))
  wss.on('connection', (ws) => {
    setTimeout(() => ws.send(JSON.stringify({ ...EVENT, message: [{ type: 'text', data: { text } }], raw_message: text })), 300)
    ws.on('message', (raw) => {
      let j
      try { j = JSON.parse(String(raw)) } catch { return }
      if (!j.action) return
      const segs = (j.params.message || []).map((m) => m.type)
      got.push({ action: j.action, segs })
    })
  })

  const logFile = path.join(os.tmpdir(), `qq-bridge-${voiceOnly ? 'voice' : 'legacy'}-${Date.now()}.log`)
  const fd = fs.openSync(logFile, 'w')
  const child = spawn(process.execPath, [BRIDGE, '--once'], {
    cwd: ROOT,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: {
      ...process.env,
      QQ_WS_URL: `ws://127.0.0.1:${wsPort}`,
      QQ_PET_API: `http://127.0.0.1:${petPort}`,
      QQ_VOICE_ONLY: voiceOnly ? '1' : '0',
      QQ_SELF_ID: String(SELF_ID),
      QQ_LOG_FILE: logFile,
    },
  })

  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !got.some((g) => g.segs.includes('record') || g.segs.includes('text'))) {
    await sleep(120)
  }
  await sleep(700) // 等第二条（表情包 / 语音）也发出来

  try { child.kill() } catch { /* noop */ }
  try { fs.closeSync(fd) } catch { /* noop */ }
  for (const c of wss.clients) { try { c.terminate() } catch { /* noop */ } }
  await new Promise((r) => wss.close(r))
  await new Promise((r) => pet.close(r))

  const all = got.flatMap((g) => g.segs)
  const hasText = all.includes('text')
  const hasRecord = all.includes('record')
  const hasImage = all.includes('image')

  const checks = []
  if (wantVoice) {
    checks.push(['发了语音', hasRecord])
    checks.push(['带了表情包', hasImage])
  } else {
    checks.push(['没合成出语音时不发 record', !hasRecord])
    checks.push(['退回发字，不是空的', hasText])
  }
  if (voiceOnly && wantVoice) checks.push(['一个字都没打', !hasText])
  if (!voiceOnly) checks.push(['老行为仍然先发字', hasText])

  const ok = checks.every(([, v]) => v)
  console.log(`\n=== ${name} ===`)
  console.log('  收到动作:', JSON.stringify(got))
  for (const [label, v] of checks) console.log(`  ${v ? '✓' : '✗'} ${label}`)
  if (!ok) {
    const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-8).join('\n')
    console.log('  桥日志尾部:\n' + tail)
  }
  return ok
}

const results = []
results.push(await runCase({
  name: '只发语音 · 有语音有表情包', voiceOnly: true, text: '在吗', wantVoice: true,
  petPort: 19110, wsPort: 19111,
}))
results.push(await runCase({
  name: '只发语音 · 语音合成失败', voiceOnly: true, text: '没声音试试', wantVoice: false,
  petPort: 19120, wsPort: 19121,
}))
results.push(await runCase({
  name: '老行为 · 文字+图+语音', voiceOnly: false, text: '在吗', wantVoice: true,
  petPort: 19130, wsPort: 19131,
}))

const pass = results.every(Boolean)
console.log(pass ? '\n全部通过' : '\n有失败项')
process.exit(pass ? 0 : 1)
