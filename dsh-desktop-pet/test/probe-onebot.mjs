import WebSocket from 'ws'

const ws = new WebSocket('ws://127.0.0.1:3001')
const waits = new Map()
let seq = 0
ws.on('message', (raw) => {
  let m
  try { m = JSON.parse(String(raw)) } catch { return }
  if (m.echo && waits.has(m.echo)) { waits.get(m.echo)(m); waits.delete(m.echo); return }
  if (m.post_type) console.log('EVENT', m.post_type, m.message_type || '', 'from', m.user_id ?? m.target_id ?? '', JSON.stringify(m.message || m.notice_type || '').slice(0, 120))
})
const call = (action, params = {}) => new Promise((res) => {
  const echo = 'p' + (++seq)
  waits.set(echo, res)
  ws.send(JSON.stringify({ action, params, echo }))
  setTimeout(() => { if (waits.has(echo)) { waits.delete(echo); res({ timeout: true }) } }, 8000)
})

await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
const login = await call('get_login_info')
console.log('登录信息:', JSON.stringify(login.data ?? login))
const ver = await call('get_version_info')
console.log('版本:', JSON.stringify(ver.data ?? ver))
const status = await call('get_status')
console.log('状态:', JSON.stringify(status.data ?? status))
const friends = await call('get_friend_list')
const fl = Array.isArray(friends.data) ? friends.data : []
console.log('好友数:', fl.length, '前几个:', fl.slice(0, 5).map((f) => `${f.user_id}:${f.nickname || f.remark}`).join(' | '))
const groups = await call('get_group_list')
const gl = Array.isArray(groups.data) ? groups.data : []
console.log('群数:', gl.length, '前几个:', gl.slice(0, 5).map((g) => `${g.group_id}:${g.group_name}`).join(' | '))
ws.close()
process.exit(0)
