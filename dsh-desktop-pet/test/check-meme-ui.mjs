#!/usr/bin/env node
/**
 * 验证表情包在页面上真的弹出来（不是只在服务端发消息）。
 *
 *   node test/check-meme-ui.mjs [pet 端口]
 *
 * 打开 /pet → 通过页面自己 fetch 触发一句会发表情的话 →
 * 等 #meme-pop.on 出现 → 报告图片是否真的加载成功 → 存一张截图。
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const PET_PORT = Number(process.argv[2] || 18765)
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9400 + Math.floor(Math.random() * 300)
const SHOT = path.join(os.tmpdir(), 'meme-ui.png')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-proxy-server',
  `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + os.tmpdir() + '/edge-meme-' + Date.now(),
  '--window-size=520,420',
  `http://127.0.0.1:${PET_PORT}/pet`,
], { stdio: 'ignore' })

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const p = list.find((t) => t.type === 'page' && t.url.includes('/pet'))
      if (p?.webSocketDebuggerUrl) return p
    } catch { /* 还没起 */ }
    await sleep(300)
  }
  throw new Error('CDP 没起来')
}

let ok = true
try {
  const page = await target()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const errs = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '')
  })
  await new Promise((r) => ws.addEventListener('open', r))
  const send = (method, params = {}) => {
    const n = ++id
    return new Promise((res) => { pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
  }
  const evalJS = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return r?.result?.value
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(2500)   // 等鲸鱼画面与 WS 就绪

  // 页面自己发起一句（同源，不受 CORS 限制）
  await evalJS(`fetch('/api/chat/say',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'今天加班到现在才回来，累死了',screen:false})}).then(r=>r.json())`)

  // 等图片弹出来（最多 20 秒）
  let state = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    state = await evalJS(`(() => {
      const el = document.getElementById('meme-pop');
      if (!el) return { found: false };
      const img = el.querySelector('img');
      return {
        found: true,
        on: el.classList.contains('on'),
        src: img.getAttribute('src'),
        loaded: img.complete && img.naturalWidth > 0,
        w: img.naturalWidth, h: img.naturalHeight,
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
      };
    })()`)
    if (state?.found && state.on) break
  }

  if (!state?.found) { console.log('✗ 页面上没有 meme-pop 元素'); ok = false }
  else {
    console.log('元素:', JSON.stringify(state))
    if (!state.on) { console.log('✗ 元素存在但没显示（on 类没加）'); ok = false }
    else if (!state.loaded) { console.log('✗ 图片没加载成功:', state.src); ok = false }
    else console.log('✓ 表情包已弹出，图片', state.w + 'x' + state.h, 'at', state.rect.x + ',' + state.rect.y)
  }

  // 截图留证（此时图还在 3.8 秒窗口内）
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) { fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64')); console.log('截图:', SHOT) }
  if (errs.length) console.log('页面异常:', errs.slice(0, 3).join(' | '))
  ws.close()
} finally {
  edge.kill()
}
process.exit(ok ? 0 : 1)
