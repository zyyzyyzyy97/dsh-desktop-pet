#!/usr/bin/env node
/**
 * 真的点一下工具栏的麦克风按钮，看整条链路通不通。
 * 用无头 Edge + 假麦克风设备（--use-fake-device-for-media-stream），
 * 这样 getUserMedia 会成功，能验证「点按钮 → 开麦 → 标志出现」。
 *
 *   node test/click-voice.mjs [pet 端口]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

const PET_PORT = Number(process.argv[2] || 18765)
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9700 + Math.floor(Math.random() * 200)
const OUT = 'click-voice.png'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream','--no-proxy-server','--proxy-bypass-list=*',
  `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + os.tmpdir() + '/edge-click-' + Date.now(),
  '--window-size=560,460',
  `http://127.0.0.1:${PET_PORT}/pet`,
], { stdio: 'ignore' })

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const p = list.find((t) => t.type === 'page' && t.url.includes('/pet'))
      if (p?.webSocketDebuggerUrl) return p
    } catch { /* 还没起 */ }
    await sleep(300)
  }
  throw new Error('CDP 没起来')
}

const page = await target()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const logs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled') {
    const t = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')
    logs.push(`[${m.params.type}] ${t}`)
  }
  if (m.method === 'Log.entryAdded') logs.push(`[log:${m.params.entry.level}] ${m.params.entry.text}`)
  if (m.method === 'Runtime.exceptionThrown') logs.push('[异常] ' + (m.params.exceptionDetails?.text || '') + ' ' + (m.params.exceptionDetails?.exception?.description || ''))
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) => {
  const n = ++id
  return new Promise((res) => { pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await sleep(3000)

// 1) 先把鼠标移到鲸鱼身上，让工具栏出现（工具栏默认 hidden）
console.log('— 让工具栏显示 —')
await send('Runtime.evaluate', {
  expression: `(() => {
    const b = document.querySelector('.body') || document.querySelector('canvas');
    const r = (b || document.body).getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    for (const type of ['pointermove', 'mousemove']) {
      document.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true }));
    }
    return 'moved to ' + Math.round(x) + ',' + Math.round(y);
  })()`,
  returnByValue: true,
}).then((r) => console.log(' ', r.result.value))
await sleep(600)

// 2) 工具栏里到底有没有麦克风按钮
const has = await send('Runtime.evaluate', {
  expression: `(() => {
    const t = document.getElementById('tools');
    const b = t && t.querySelector('[data-action="voice"]');
    return JSON.stringify({
      toolsHidden: t ? t.hidden : null,
      toolIds: t ? [...t.children].map(x => x.dataset.action) : null,
      hasVoice: !!b,
      voiceClass: b ? b.className : null,
    });
  })()`,
  returnByValue: true,
})
console.log('— 工具栏状态 —\n ', has.result.value)

// 3) 真点它：pointerdown + pointerup，和鼠标点击同一路径
console.log('— 点击麦克风 —')
await send('Runtime.evaluate', {
  expression: `(() => {
    const b = document.querySelector('[data-action="voice"]');
    if (!b) return 'no-button';
    const r = b.getBoundingClientRect();
    const o = { button: 0, bubbles: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
    b.dispatchEvent(new PointerEvent('pointerdown', o));
    b.dispatchEvent(new PointerEvent('pointerup', o));
    return 'clicked';
  })()`,
  returnByValue: true,
}).then((r) => console.log(' ', r.result.value))
await sleep(2500)

// 4) 结果
const state = await send('Runtime.evaluate', {
  expression: `(() => {
    const bub = document.getElementById('bubble');
    const f = document.querySelector('.b-mic');
    const b = document.querySelector('[data-action="voice"]');
    return JSON.stringify({
      bubbleHidden: bub ? bub.hidden : null,
      micFlag: f ? { hidden: f.hidden, cls: f.className, text: f.querySelector('.b-mic-t')?.textContent, display: getComputedStyle(f).display } : null,
      voiceBtnClass: b ? b.className : null,
    }, null, 1);
  })()`,
  returnByValue: true,
})
console.log('— 点击后页面 —\n ', state.result.value)

if (logs.length) {
  console.log('— 页面 console —')
  for (const l of logs.slice(-15)) console.log(' ', l)
} else console.log('— 页面 console：无输出 —')

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
console.log('截图:', OUT)

ws.close()
edge.kill()
process.exit(0)
