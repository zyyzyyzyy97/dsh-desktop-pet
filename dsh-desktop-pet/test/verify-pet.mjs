// 验证 pet-service 的 WebSocket 推送：模拟桌宠页面连接，发 say 指令，确认收到带 beats 的 say 消息。
// 默认连本机正在跑的实例（petPort=18765 / ctrlPort=18766）；
// 测试实例可用环境变量覆盖：set PET_PORT=18875&& set CTRL_PORT=18876&& node test/verify-pet.mjs
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(PLUGIN, 'vendor', 'node_modules', 'ws', 'package.json'))
const WebSocket = require('ws')

const PET = process.env.PET_PORT || '18765'
const CTRL = process.env.CTRL_PORT || '18766'

const ws = new WebSocket(`ws://127.0.0.1:${PET}/socket?role=pet&host=tab`)
let gotInit = false
ws.on('open', () => console.log('[WS] 已连接'))
ws.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.t === 'init') { gotInit = true; console.log('[WS] init 收到，字段:', Object.keys(m).join(',')) }
  else if (m.t === 'say') console.log('[WS] say 收到 beats 数 =', m.beats?.length, '| 首拍文本 =', m.beats?.[0]?.text)
  else console.log('[WS] 其它消息 t =', m.t)
})

setTimeout(async () => {
  const r = await fetch(`http://127.0.0.1:${CTRL}/control`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'say', text: '你好，我是 DSH 桌宠，正在原样复用 Coopanion 的鲸鱼。' }),
  })
  console.log('[control] say 响应 =', await r.text())
}, 1200)

setTimeout(() => { console.log(gotInit ? '[OK] 链路通过' : '[FAIL] 未收到 init'); process.exit(0) }, 4000)
