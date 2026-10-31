/**
 * dsh-voice-picker 独立冒烟测试（不依赖 DSH，不碰任何真实文件）。
 *
 * 起 mock 的 pet（/api/config GET/POST）和 ctrl（/control），把 picker 指过去，
 * 逐条验证路由行为与安全边界。试听走 VP_FAKE_TTS=1 的离线钩子。
 *
 * 运行：node test/smoke.mjs
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { startPickerServer } from '../src/server.mjs'

process.env.VP_FAKE_TTS = '1'

const state = { petTtsVoice: 'Cherry', lastCtrl: null, petUp: true }

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}
function readBody(req) {
  return new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)) })
}

const mockPet = http.createServer(async (req, res) => {
  if (!state.petUp) { res.destroy(); return }
  if (req.url === '/api/config' && req.method === 'GET') {
    return json(res, 200, { ttsVoice: state.petTtsVoice, apiKey: 'sk-mock-key', baseUrl: 'https://mock.invalid/v1', voiceOut: true, name: '测试鲸' })
  }
  if (req.url === '/api/config' && req.method === 'POST') {
    const patch = JSON.parse(await readBody(req) || '{}')
    if ('ttsVoice' in patch) state.petTtsVoice = patch.ttsVoice
    return json(res, 200, { ok: true, ttsVoice: state.petTtsVoice })
  }
  json(res, 404, {})
})
const mockCtrl = http.createServer(async (req, res) => {
  if (req.url === '/control' && req.method === 'POST') {
    state.lastCtrl = JSON.parse(await readBody(req) || '{}')
    return json(res, 200, { ok: true })
  }
  json(res, 404, {})
})
await new Promise((r) => mockPet.listen(0, '127.0.0.1', r))
await new Promise((r) => mockCtrl.listen(0, '127.0.0.1', r))
const petPort = mockPet.address().port
const ctrlPort = mockCtrl.address().port

const picker = await startPickerServer({ port: 18798, petPort, ctrlPort, log: () => {} })
const base = `http://127.0.0.1:${picker.port}`
console.log('[smoke] picker =', base, '| mock pet =', petPort, '| mock ctrl =', ctrlPort)

const results = []
function check(name, fn) {
  return fn().then(
    () => { results.push(['PASS', name]); console.log('  ✓', name) },
    (e) => { results.push(['FAIL', name + ' :: ' + e.message]); console.error('  ✗', name, '::', e.message) },
  )
}

await check('GET / 返回工作台页面', async () => {
  const r = await fetch(base + '/')
  const html = await r.text()
  assert.equal(r.status, 200)
  assert.ok(html.includes('音色工作台'))
  assert.ok(html.includes('试听'))
})

await check('GET /api/voices：48 个、当前 Cherry、无密钥泄露', async () => {
  const r = await fetch(base + '/api/voices')
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.equal(j.count, 48)
  assert.equal(j.voices.length, 48)
  assert.equal(j.current, 'Cherry')
  assert.equal(j.petOnline, true)
  assert.ok(j.hasKey)
  const body = JSON.stringify(j)
  assert.ok(!body.includes('sk-mock-key'), '密钥泄露到页面！')
  const ids = new Set(j.voices.map((v) => v.id))
  assert.equal(ids.size, 48, '音色 id 有重复')
  for (const v of j.voices) {
    assert.ok(v.id && v.zh && v.desc && v.gender && v.lang, '字段不全: ' + JSON.stringify(v))
  }
})

await check('POST /api/apply：Serena 热切换成功且 mock pet 收到', async () => {
  const r = await fetch(base + '/api/apply', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice: 'Serena' }),
  })
  const j = await r.json()
  assert.equal(j.ok, true, JSON.stringify(j))
  assert.equal(j.current, 'Serena')
  assert.equal(state.petTtsVoice, 'Serena', 'mock pet 没收到 ttsVoice')
  assert.equal(state.lastCtrl?.action, 'say', '没让鲸鱼说确认句')
  assert.match(state.lastCtrl?.text || '', /新声音/)
})

await check('POST /api/apply：非法 id 拒绝（400）', async () => {
  const r = await fetch(base + '/api/apply', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice: 'bad voice!"#' }),
  })
  assert.equal(r.status, 400)
  const j = await r.json()
  assert.equal(j.ok, false)
  assert.equal(state.petTtsVoice, 'Serena', '非法请求不应该改到 pet')
})

await check('POST /api/apply：pet 离线时给友好错误（502）', async () => {
  state.petUp = false
  try {
    const r = await fetch(base + '/api/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: 'Moon' }),
    })
    assert.equal(r.status, 502)
    const j = await r.json()
    assert.equal(j.ok, false)
    assert.match(j.error, /没在线|启动 DSH/)
  } finally { state.petUp = true }
})

await check('POST /api/preview：返回 audio/wav（fake 钩子）', async () => {
  const r = await fetch(base + '/api/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice: 'Moon', text: '测试一句话' }),
  })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') || '', /audio\/wav/)
  const buf = Buffer.from(await r.arrayBuffer())
  assert.ok(buf.length > 1000)
  assert.equal(buf.slice(0, 4).toString('ascii'), 'RIFF')
})

await check('POST /api/preview：缺参数 400', async () => {
  const r = await fetch(base + '/api/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(r.status, 400)
})

await check('GET /api/voices：pet 离线时仍返回列表（离线兜底）', async () => {
  state.petUp = false
  try {
    const r = await fetch(base + '/api/voices')
    const j = await r.json()
    assert.equal(j.count, 48)
    assert.equal(j.petOnline, false)
  } finally { state.petUp = true }
})

await check('未知路由 404', async () => {
  const r = await fetch(base + '/api/nope')
  assert.equal(r.status, 404)
})

picker.close()
mockPet.close()
mockCtrl.close()

const fails = results.filter(([s]) => s === 'FAIL')
console.log(`\n[smoke] ${results.length - fails.length}/${results.length} 通过`)
if (fails.length) { for (const [, m] of fails) console.error('  FAIL:', m); process.exit(1) }
console.log('[smoke] 全部通过 ✔')
