#!/usr/bin/env node
/**
 * 端到端验证「鲸鱼麦克风 → 本地识别」这条链路，不需要真的对着麦说话：
 * 读一个 wav，按 web/mic-worklet.js 的格式（16 kHz 单声道 PCM16，320 样本 = 20 ms 一帧）
 * 通过 WebSocket 发给 pet-service，然后看它有没有识别出文字。
 *
 *   node test/verify-voice-e2e.mjs <wav 路径> [端口]
 *
 * 前提：pet-service 正在跑（PET_PORT，默认 18765）。
 */
import fs from 'node:fs'

const file = process.argv[2]
const port = Number(process.argv[3] || process.env.PET_PORT || 18765)
if (!file) { console.error('用法：node test/verify-voice-e2e.mjs <wav> [端口]'); process.exit(2) }

/** 读 44 字节标准头之外，只处理 PCM16 单声道；别的采样率线性重采样到 16k。 */
function readWav(path) {
  const buf = fs.readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 wav')
  let at = 12, fmt = null, data = null
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) }
    } else if (id === 'data') {
      data = buf.subarray(at + 8, at + 8 + size)
      break
    }
    at += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('wav 里没有 fmt/data')
  if (fmt.bits !== 16) throw new Error(`只支持 16bit，这个是 ${fmt.bits}bit`)
  // 多声道取第一声道
  let pcm = new Int16Array(data.length / 2)
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2)
  if (fmt.channels > 1) {
    const mono = new Int16Array(Math.floor(pcm.length / fmt.channels))
    for (let i = 0; i < mono.length; i++) mono[i] = pcm[i * fmt.channels]
    pcm = mono
  }
  if (fmt.rate !== 16000) pcm = resample(pcm, fmt.rate, 16000)
  return pcm
}

function resample(pcm, from, to) {
  const n = Math.floor((pcm.length * to) / from)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * from) / to
    const i0 = Math.floor(x), i1 = Math.min(i0 + 1, pcm.length - 1)
    out[i] = Math.round(pcm[i0] * (1 - (x - i0)) + pcm[i1] * (x - i0))
  }
  return out
}

const pcm = readWav(file)
console.log(`音频 ${(pcm.length / 16000).toFixed(1)}s，${Math.ceil(pcm.length / 320)} 帧`)

const ws = new WebSocket(`ws://127.0.0.1:${port}/socket?role=pet`)
const seen = []
ws.addEventListener('message', (e) => {
  if (typeof e.data !== 'string') return
  let m = null
  try { m = JSON.parse(e.data) } catch { return }
  if (m.t === 'init' || m.t === 'prefs') return
  if (m.t === 'asr' || m.t === 'mic' || m.t === 'said' || m.t === 'say') {
    seen.push(m)
    const brief = { asr: `phase=${m.phase}${m.text ? ' 文本=' + m.text : ''}${m.hint ? ' 提示=' + m.hint : ''}`,
      mic: `state=${m.state}`, said: String(m.text || '').slice(0, 40), say: '气泡:' + JSON.stringify(m.beats?.[0] ?? '').slice(0, 40) }[m.t]
    console.log(`  [收到 ${m.t}] ${brief}`)
  }
})

ws.addEventListener('open', async () => {
  console.log('WS 已连上，开始按 20ms 一帧发音频…')
  // 先静音 200ms，让服务端知道「还没开口」
  const silence = new Int16Array(320)
  for (let i = 0; i < 10; i++) { ws.send(silence.buffer.slice(0)); await sleep(20) }
  for (let at = 0; at < pcm.length; at += 320) {
    const frame = pcm.subarray(at, Math.min(at + 320, pcm.length))
    ws.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength))
    await sleep(20)
  }
  console.log('音频发完，等静音判定…')
  // 后跟 1.2s 静音触发收尾
  for (let i = 0; i < 60; i++) { ws.send(silence.buffer.slice(0)); await sleep(20) }
  await sleep(2500)
  const hit = seen.find((m) => m.t === 'asr' && m.text)
  console.log(hit ? `\n结论：识别成功 →「${hit.text}」` : '\n结论：没拿到识别文本，见上面收到的消息。')
  ws.close()
  process.exit(hit ? 0 : 1)
})

ws.addEventListener('error', (e) => { console.error('WS 出错：', e.message || e); process.exit(1) })

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
