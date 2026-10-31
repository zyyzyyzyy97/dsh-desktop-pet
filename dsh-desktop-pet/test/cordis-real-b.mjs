// 真实 Cordis 加载路线 B 插件：确认 apply 是否执行、pet-service 子进程是否起来、
// 会话事件能否端到端驱动鲸鱼说话。
// 注意：刻意不给 coopanionTsx —— 顺便验证 src/index.js 能自动解析 tsx
//（优先插件 npm 自带的 node_modules/tsx，找不到再试 Coopanion 安装位）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')

// DSH 工具链自带的 @deepseek-ai/cordis（~/.workbuddy/binaries/node/versions/<最新>/node_modules）
function findDshPkg() {
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions')
  try {
    const vers = fs.readdirSync(base).filter((x) => /^\d/.test(x)).sort().reverse()
    for (const v of vers) {
      const p = path.join(base, v, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      if (fs.existsSync(p)) return p
    }
  } catch { /* 目录不存在 */ }
  throw new Error('没找到 DSH 工具链（~/.workbuddy/binaries/node/versions/*/node_modules/@deepseek-ai/dsh）——本测试需要 DSH 自带的 cordis')
}

const require = createRequire(findDshPkg())
const { Context } = require('@deepseek-ai/cordis')
const WebSocket = require(path.join(PLUGIN, 'vendor', 'node_modules', 'ws'))

const mod = await import(pathToFileURL(path.join(PLUGIN, 'src', 'index.js')).href)
console.log('[test] apply 类型 =', typeof mod.apply, '| name =', mod.name)

const cfg = {
  ctrlPort: 18878,
  petPort: 18877,
  autoOpen: false,
}
const root = new Context()
const r = root.plugin(mod, cfg)
try { await r } catch (e) { console.log('[test] fiber err:', String(e)) }
console.log('[test] root.pet?', !!root.pet)
if (typeof root.start === 'function') { try { await root.start() } catch (e) { console.log('[test] start err:', String(e)) } }
await new Promise((res) => setTimeout(res, 4000))

const listening = await new Promise((res) => {
  const s = net.connect(18877, '127.0.0.1')
  s.on('connect', () => { s.destroy(); res(true) })
  s.on('error', () => res(false))
})
console.log('[test] 端口 18877 监听?', listening)
if (!listening) process.exit(1)

const ws = new WebSocket('ws://127.0.0.1:18877/socket?role=pet&host=tab')
ws.on('error', (e) => { console.log('[test] ws err', e.message); process.exit(1) })
ws.on('open', () => console.log('[test] WS 连上'))
ws.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.t === 'say') { console.log('[端到端 OK] 鲸鱼说:', m.beats?.[0]?.text); process.exit(0) }
})
setTimeout(() => {
  // 模拟 DSH 真实会话事件，验证 event → drive → 鲸鱼说话 全链路
  root.emit('session/event', { id: 's1' }, { type: 'assistant/message', message: { content: 'DSH 会话事件驱动的原样鲸鱼' } })
  console.log('[test] 已 emit session/event(assistant/message)')
}, 600)
setTimeout(() => { console.log('[FAIL] 超时未收到 say'); process.exit(1) }, 6000)
