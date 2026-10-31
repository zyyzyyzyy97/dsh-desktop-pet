#!/usr/bin/env node
/**
 * 用无头 Edge + CDP 打开 /pet，模拟「麦克风打开」，截一张输入框的图。
 * 只给开发时看 UI 用。
 *
 *   node test/shot-voice-flag.mjs [pet 端口] [输出 png]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const PET_PORT = Number(process.argv[2] || 18875)
const OUT = process.argv[3] || 'voice-flag.png'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9333

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + process.env.TEMP + '/edge-cdp-voice',
  '--window-size=520,420',
  `http://127.0.0.1:${PET_PORT}/pet`,
], { stdio: 'ignore' })

/** 等调试端口起来 */
async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('/pet'))
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* 还没起 */ }
    await sleep(300)
  }
  throw new Error('CDP 没起来')
}

const page = await targets()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))

function send(method, params = {}) {
  const n = ++id
  return new Promise((res) => { pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
}

await send('Page.enable')
await send('Runtime.enable')
await sleep(2500) // 等鲸鱼骨架和 ws 连上

// 点工具栏的「聊天」图标打开输入框（和用户双击鲸鱼等效）
const opened = await send('Runtime.evaluate', {
  expression: `(() => {
    const b = document.querySelector('[data-action="chat"]');
    if (!b) return 'no-chat-button';
    b.click();
    return 'clicked';
  })()`,
  returnByValue: true,
})
console.log('打开输入框:', opened.result.value)
await sleep(800)

// 语音状态由模块内部维护，这里直接把它画成「正在听」来看样式
await send('Runtime.evaluate', {
  expression: `(() => {
    const f = document.querySelector('.b-mic');
    if (!f) return 'no-flag';
    f.hidden = false; f.className = 'b-mic live';
    f.querySelector('.b-mic-t').textContent = '正在听';
    return 'painted';
  })()`,
  returnByValue: true,
})
await sleep(400)

const check = await send('Runtime.evaluate', {
  expression: `(() => {
    const f = document.querySelector('.b-mic');
    return JSON.stringify({
      hasFlag: !!f,
      hidden: f ? f.hidden : null,
      cls: f ? f.className : null,
      text: f ? (f.querySelector('.b-mic-t') || {}).textContent : null,
      display: f ? getComputedStyle(f).display : null,
      color: f ? getComputedStyle(f).color : null,
      bubbleHTML: document.getElementById('bubble').innerHTML.slice(0, 120),
    });
  })()`,
  returnByValue: true,
})
console.log('页面状态:', check.result.value)

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
console.log('截图:', OUT)

ws.close()
edge.kill()
process.exit(0)
