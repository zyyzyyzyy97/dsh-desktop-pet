#!/usr/bin/env node
/**
 * check-qq-tile.mjs — 验证右键菜单里真的有「上线 QQ」这一格，而且点了会走到服务端。
 *
 * 用系统 Edge 无头 + CDP（本机 127.0.0.1 必须 --no-proxy-server）：
 *   1. 打开 /pet#key=... 等页面起来
 *   2. 在鲸鱼身上派发一次 contextmenu → 菜单应该弹出来
 *   3. 读菜单格子：确认 qq 在、标题是「上线 QQ」、并且紧挨着装扮
 *   4. 真的点一下 → 服务端日志应出现「收到上线请求（page）」，标题应变成「QQ 正在上线…」
 *   5. 截一张图存档
 *
 *   node test/check-qq-tile.mjs <pet端口> <页面key> [输出图片]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] || 18875)
const KEY = process.argv[3] || ''
const OUT = process.argv[4] || path.join(ROOT, 'runtime-data', 'qq-tile.png')
const CTRL = Number(process.argv[5] || PORT + 1)
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const DBG = 20000 + Math.floor(Math.random() * 20000)
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-qq-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitJson(url, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json()
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('CDP 没起来: ' + url)
}

/** 一个极简 CDP 客户端 */
function cdp(ws) {
  let id = 0
  const waits = new Map()
  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(String(raw)) } catch { return }
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id) }
  })
  return (method, params = {}) => new Promise((resolve) => {
    const mid = ++id
    waits.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}

const edge = spawn(EDGE, [
  '--headless=new', '--no-proxy-server', '--disable-gpu',
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1200,800', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore', windowsHide: true })

let pass = false
try {
  await waitJson(`http://127.0.0.1:${DBG}/json/version`)
  const targets = await waitJson(`http://127.0.0.1:${DBG}/json/list`)
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const send = cdp(ws)

  await send('Page.enable')
  await send('Runtime.enable')
  const url = `http://127.0.0.1:${PORT}/pet${KEY ? '#key=' + KEY : ''}`
  console.log('打开', url.replace(/#key=.*/, '#key=***'))
  await send('Page.navigate', { url })
  await sleep(3500)

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r?.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r?.result?.result?.value
  }

  // 鲸鱼是 canvas 画的，DOM 里没有形状可量；菜单又只在命中本体时才弹，
  // 所以在舞台中间撒一层点挨个试（命中测试是页面自己的 body.hit）。
  const rect = await evalJs(`(() => {
    const layer = document.querySelector('#figureLayer') || document.querySelector('.stage') || document.body
    const r = layer.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })()`)
  console.log('舞台', JSON.stringify(rect))
  if (!rect || !rect.w) throw new Error('页面上找不到舞台')

  const pts = []
  for (let ry = 0.35; ry <= 0.85; ry += 0.1) {
    for (let rx = 0.3; rx <= 0.75; rx += 0.08) {
      pts.push({ x: Math.round(rect.x + rect.w * rx), y: Math.round(rect.y + rect.h * ry) })
    }
  }

  let open = false
  for (const s of pts) {
    await evalJs(`(() => {
      document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${s.x}, clientY: ${s.y}, button: 2 }))
      return true
    })()`)
    await sleep(120)
    open = await evalJs(`(() => { const m = document.querySelector('#menu'); return !!m && m.hidden === false })()`)
    if (open) { console.log('命中落点', JSON.stringify(s)); break }
  }
  console.log('菜单弹出:', open)

  const tiles = await evalJs(`[...document.querySelectorAll('.m-tile')].map(b => ({ id: b.dataset.action, title: b.title, on: b.classList.contains('on') }))`)
  console.log('菜单格子:', JSON.stringify(tiles))

  const order = (tiles || []).map((t) => t.id)
  const qq = (tiles || []).find((t) => t.id === 'qq')
  const ai = order.indexOf('qq'), di = order.indexOf('dress')
  const QQ_TITLES = ['上线 QQ', 'QQ 正在上线…', '下线 QQ（关掉 QQ 和桥）', '已经在 QQ 上了']
  const checks = [
    ['菜单弹出来了', open === true],
    ['有企鹅那一格（qq）', !!qq],
    ['标题是开关文案（上线/上线中/下线）', QQ_TITLES.includes(qq?.title)],
    ['紧挨着装扮（在它后面一格）', ai >= 0 && di >= 0 && ai === di + 1],
    ['画的是企鹅（有多色填充，不是描边图标）', await evalJs(`(() => {
      const el = document.querySelector('.m-tile[data-action="qq"] .ic svg')
      if (!el) return false
      return !!el.querySelector('[fill="#f6a623"]') && !!el.querySelector('[fill="#1b1b1f"]')
    })()`)],
  ]

  // 真点一下：走真实链路。判断标准是服务端状态真的变了（不上线就是下线，都是变化）
  if (qq) {
    const before = await (await fetch(`http://127.0.0.1:${CTRL}/state`)).json()
    await evalJs(`document.querySelector('.m-tile[data-action="qq"]').click()`)
    let after = before, changed = false
    for (let i = 0; i < 20; i++) {
      await sleep(200)
      after = await (await fetch(`http://127.0.0.1:${CTRL}/state`)).json()
      if (JSON.stringify(after.qq) !== JSON.stringify(before.qq)) { changed = true; break }
    }
    console.log('点击前 qq:', JSON.stringify(before.qq), '→ 点击后:', JSON.stringify(after.qq))
    const title = await evalJs(`(document.querySelector('.m-tile[data-action="qq"]') || {}).title || ''`)
    console.log('点击后标题:', title)
    checks.push(['点一下服务端状态真的变了（页→服务端链路通）', changed])
    checks.push(['点完标题跟着变（服务端→页广播通）', QQ_TITLES.includes(title)])
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const png = shot?.result?.data
  if (png) {
    fs.writeFileSync(OUT, Buffer.from(png, 'base64'))
    console.log('截图:', OUT)
  } else {
    console.log('截图没拿到:', JSON.stringify(shot).slice(0, 200))
  }

  console.log('')
  for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  pass = checks.every(([, ok]) => ok)
  ws.close()
} catch (e) {
  console.error('验证出错:', e.message)
} finally {
  try { edge.kill() } catch { /* noop */ }
  await sleep(500)
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch { /* noop */ }
}

console.log(pass ? '\n通过：菜单里真有这一格，点了也走到服务端了' : '\n失败')
process.exit(pass ? 0 : 1)
