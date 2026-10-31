/**
 * 假 NapCat：起一个 OneBot 11 正向 WS 服务端，用来验证 qq-bridge 的收发，
 * 不用真的登录 QQ。
 *
 *   node test/fake-onebot.mjs 19501            # 等服务端连进来
 *   连上后按回车/或自动发一条，看桥有没有把 send_private_msg 发回来
 */
import { WebSocketServer } from 'ws'

const port = Number(process.argv[2] || 19501)
const selfId = 900000001
const wss = new WebSocketServer({ port })
console.log(`[fake] 监听 ws://127.0.0.1:${port}`)

const scenarios = [
  {
    name: '私聊 · 纯文字',
    ev: {
      post_type: 'message', message_type: 'private', self_id: selfId,
      user_id: 123456, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text: '你在干嘛呢' } }],
      raw_message: '你在干嘛呢',
      sender: { user_id: 123456, nickname: '炸洋芋' },
    },
  },
  {
    name: '群聊 · 没 @ 她，应该被忽略',
    ev: {
      post_type: 'message', message_type: 'group', self_id: selfId,
      user_id: 123456, group_id: 555000, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text: '今天吃啥' } }],
      raw_message: '今天吃啥',
      sender: { user_id: 123456, nickname: '路人' },
    },
  },
  {
    name: '群聊 · @ 她',
    ev: {
      post_type: 'message', message_type: 'group', self_id: selfId,
      user_id: 123457, group_id: 555000, time: Math.floor(Date.now() / 1000),
      message: [
        { type: 'at', data: { qq: String(selfId) } },
        { type: 'text', data: { text: ' 小女子 这题选什么' } },
      ],
      raw_message: `[CQ:at,qq=${selfId}] 小女子 这题选什么`,
      sender: { user_id: 123457, nickname: '同学' },
    },
  },
]

wss.on('connection', (ws) => {
  console.log('[fake] 桥连进来了')
  let i = 0
  const next = () => {
    if (i >= scenarios.length) {
      console.log('[fake] 场景跑完，5 秒后退出')
      setTimeout(() => process.exit(0), 5000)
      return
    }
    const s = scenarios[i++]
    console.log(`\n[fake] >>> 发送场景 ${i}: ${s.name}`)
    ws.send(JSON.stringify(s.ev))
    setTimeout(next, 12000)
  }
  setTimeout(next, 1200)

  ws.on('message', (raw) => {
    let j
    try { j = JSON.parse(String(raw)) } catch { return }
    if (!j.action) return
    console.log(`[fake] <<< 收到动作 ${j.action}`, JSON.stringify(j.params).slice(0, 220))
  })
  ws.on('close', () => console.log('[fake] 桥断开了'))
})
