#!/usr/bin/env node
/**
 * check-qq-ws.mjs — 「上线 QQ」那一格的数据链路，不依赖浏览器。
 *
 * 验三件事：
 *   1. 页面连上 /socket 后，init 快照里带 qq 状态（否则那一格永远画不出在线灯）
 *   2. POST /control {action:'qq'} 之后，服务端会广播 {t:'qq', busy:true}
 *   3. 服务端真发给页面的 pet-app.js / i18n 里确实有这一格（不是只改了磁盘文件）
 *
 *   node test/check-qq-ws.mjs <pet端口> <ctrl端口> <页面key>
 */
import WebSocket from 'ws'

const PORT = Number(process.argv[2] || 18875)
const CTRL = Number(process.argv[3] || 18876)
const KEY = process.argv[4] || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const got = []
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket?role=pet&host=tab${KEY ? '&key=' + KEY : ''}`)
ws.on('message', (raw) => {
  try { got.push(JSON.parse(String(raw))) } catch { /* noop */ }
})
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
ws.send(JSON.stringify({ t: 'hello', screen: { w: 380, h: 420 }, host: 'tab' }))
await sleep(1200)

const init = got.find((m) => m.t === 'init')
console.log('init 里的 qq:', JSON.stringify(init?.qq))

const r = await fetch(`http://127.0.0.1:${CTRL}/control`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'qq' }),
})
console.log('control 返回:', await r.text())
await sleep(400)

// 连点：第二下必须被 busy 挡住，不该再走一遍上线流程
const r2 = await fetch(`http://127.0.0.1:${CTRL}/control`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'qq' }),
})
console.log('连点第二下:', await r2.text())
await sleep(1200)

const pushed = got.filter((m) => m.t === 'qq')
console.log('收到的 qq 广播:', JSON.stringify(pushed))

// 下线：桥要停、状态要回到 offline
await fetch(`http://127.0.0.1:${CTRL}/control`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'qq-off' }),
})
await sleep(1500)
const afterOff = got.filter((m) => m.t === 'qq').at(-1)
console.log('下线后的广播:', JSON.stringify(afterOff))

const js = await (await fetch(`http://127.0.0.1:${PORT}/web/pet-app.js`)).text()
const zh = await (await fetch(`http://127.0.0.1:${PORT}/web/i18n/zh.js`)).text()
const ui = await (await fetch(`http://127.0.0.1:${PORT}/web/ui.js`)).text()
const served = {
  icon: /ICONS\.qq/.test(js),
  toggle: /qq-off/.test(js),
  label: zh.includes('上线 QQ') && zh.includes('下线 QQ'),
  onOrder: /case 'qq':/.test(js),
  penguin: /glyph\(/.test(ui) && /#f6a623/.test(ui),
}

const busyCount = pushed.filter((m) => m.busy === true).length
const checks = [
  ['init 快照带 qq 状态', !!init?.qq && typeof init.qq.online === 'boolean'],
  ['点了之后进了在线态或上线中', pushed.some((m) => m.busy === true || m.online === true)],
  ['连点没有起第二轮（busy:true 最多一次）', busyCount <= 1],
  ['下线后广播 online:false busy:false', afterOff?.online === false && afterOff?.busy === false],
  ['状态回到「已下线」', afterOff?.note === '已下线'],
  ['服务端发的 pet-app.js 里是开关 + 有这一格', served.icon && served.onOrder && served.toggle],
  ['zh.js 里有上线/下线两句文案', served.label],
  ['ui.js 里是企鹅（彩色 glyph）', served.penguin],
]
for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`)
console.log('服务端实际提供:', JSON.stringify(served))

ws.close()
const pass = checks.every(([, ok]) => ok)
console.log(pass ? '\n通过' : '\n失败')
process.exit(pass ? 0 : 1)
