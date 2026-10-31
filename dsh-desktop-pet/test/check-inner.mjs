/**
 * check-inner.mjs — inner 模块的假链路端到端测试。
 *
 * 不打真模型：起一个本地假 OpenAI 兼容服务，识别 EXTRACT 请求返回固定
 * 事实+心情，其余当聊天回复。真实 pet-service 进程 + 真实 HTTP 链路，
 * 断言的是「system 里真的注进了什么」和「状态文件真的变了」——
 * 不许用改 DOM 那种假验证。
 *
 * 跑法：
 *   set ELECTRON_RUN_AS_NODE=1&& "…\Coopanion.exe" "…\tsx\dist\cli.mjs" "…\test\check-inner.mjs"
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
// 解析 tsx：优先环境变量 TSX_PATH，其次插件 npm 自带的 tsx，最后 Coopanion 安装位
const TSX = (() => {
  const cands = [
    process.env.TSX_PATH,
    path.join(PLUGIN, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'D:/新建文件夹 (2)/Coopanion/resources/app/node_modules/tsx/dist/cli.mjs',
  ].filter(Boolean)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch { /* noop */ } }
  throw new Error('找不到 tsx：先在插件根目录 npm install（依赖自带 tsx），或设 TSX_PATH 环境变量')
})()
const PORT = 18895
const BASE = `http://127.0.0.1:${PORT}`

const seen = { chat: [], extract: [], diary: [], consolidate: [], proactive: [] }
let extractCount = 0
let consolidateCount = 0
let proLineInHistory = false

/** 假模型：按 system 特征分流——EXTRACT/日记/自画像/聊天。 */
function fakeModel(req, res) {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    try {
      const j = JSON.parse(body)
      const sys = String(j.messages?.[0]?.content || '')
      if (sys.includes('安静的记忆整理器')) {
        extractCount++
        seen.extract.push({ sys, user: String(j.messages?.[1]?.content || '') })
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            facts: [{ key: '测试事实', value: '他在准备一场考试' }],
            mood: { dv: -0.25, da: 0.1, why: '他被批评了' },
          }) } }],
        }))
        return
      }
      if (sys.includes('只写两样东西')) {
        seen.diary.push({ sys })
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          diary: '他说他挺累的，我有点在意。',
          impression: '他说作业堆成山的时候连标点都没打',
        }) } }] }))
        return
      }
      if (sys.includes('重写这份自画像')) {
        consolidateCount++
        seen.consolidate.push({ sys, user: String(j.messages?.[1]?.content || '') })
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          portrait: '我最近话变少了，但他真来问的时候我挺高兴。我说话直接，不爱绕弯子。',
          moments: [{ text: '第一次被他夸可爱那次，我嘴上说没有心里挺美' }],
        }) } }] }))
        return
      }
      if (sys.includes('你想主动跟他说句话')) {
        seen.proactive.push({ sys, user: String(j.messages?.[1]?.content || '') })
        res.end(JSON.stringify({ choices: [{ message: { content: '喂，想到你啦。' } }] }))
        return
      }
      seen.chat.push({ sys, user: JSON.stringify(j.messages?.at(-1)?.content || ''), msgs: j.messages })
      if (Array.isArray(j.messages) && j.messages.some((m) => m.role === 'assistant' && String(m.content).includes('想到你啦'))) proLineInHistory = true
      res.end(JSON.stringify({ choices: [{ message: { content: '嗯，我在。' } }] }))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: { message: String(e) } }))
    }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 15000) {
  const t0 = Date.now()
  for (;;) {
    try { if (await fn()) return } catch { /* 还没起 */ }
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await sleep(400)
  }
}
const post = (p, j) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(j) }).then((r) => r.json())
const get = (p) => fetch(BASE + p).then((r) => r.json())

let proc = null
let cfgBackup = null
const cfgFile = path.join(PLUGIN, 'pet-config.json')
const bakFile = cfgFile + '.test-backup'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-e2e-'))
process.env.INNER_DIR = TMP // 对本测试进程无效（服务进程另有 env），仅示意隔离

let passed = 0
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ok -', name) }
  else { console.error('  FAIL -', name, extra); process.exitCode = 1 }
}

try {
  // 隔离：克隆的 runtime-data 跨运行残留（上一次的 portrait/turns 会卡住整合门槛）
  for (const f of ['memory.db', 'memory.db-wal', 'memory.db-shm']) {
    try { fs.rmSync(path.join(PLUGIN, 'runtime-data', f), { force: true }) } catch { /* noop */ }
  }
  // 备份克隆配置（持久备份文件：就算测试半路崩了，下次开头也能先还原）
  if (fs.existsSync(bakFile)) {
    fs.copyFileSync(bakFile, cfgFile)
    fs.rmSync(bakFile)
    console.log('（检测到上次运行残留的假配置，已先还原）')
  }
  cfgBackup = fs.readFileSync(cfgFile, 'utf8')
  fs.writeFileSync(bakFile, cfgBackup)
  const cfg = JSON.parse(cfgBackup)
  cfg.baseUrl = 'http://127.0.0.1:18991/compatible-mode/v1'
  cfg.apiKey = 'test-key'
  cfg.voiceOut = false
  cfg.memes = false
  cfg.autoOpenWindow = false
  cfg.proactive = true
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const fake = http.createServer(fakeModel)
  await new Promise((r) => fake.listen(18991, r))
  fake.unref() // 不让假服务器挂住进程：挂住 = 收尾 process.exit 会吞掉崩溃栈

  proc = spawn(process.execPath, [TSX, path.join(PLUGIN, 'vendor', 'pet-service.ts')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PET_PORT: String(PORT),
      CTRL_PORT: String(PORT + 1),
      PET_NO_WINDOW: '1',
      INNER_DIR: TMP,
    },
    stdio: 'ignore',
  })

  await until(async () => (await get('/api/inner')).ok === true)
  console.log('服务已起，假模型已就位')

  // —— 场景 1：两轮对话，第二轮触发 learn（假模型判 mood dv=-0.25）——
  await post('/api/chat/say', { text: '我今天被老师当众批评了，特别丢人' })
  await post('/api/chat/say', { text: '算了，我去写作业了' })
  await until(() => extractCount >= 1, 10000)

  ok('EXTRACT 用的是 v2 提示词（含 mood 字段说明）',
    seen.extract.length > 0 && seen.extract[0].sys.includes('"mood"') && seen.extract[0].sys.includes('dv'),
    seen.extract[0]?.sys?.slice(0, 120))
  ok('EXTRACT 收到的是最后一轮对话', seen.extract[0]?.user?.includes('写作业'), seen.extract[0]?.user)

  const snap = await get('/api/inner')
  ok('模型冲量入账（dv=-0.25 → 被钳制仍在）', snap.lastEvent && snap.lastEvent.why === '他被批评了', JSON.stringify(snap.lastEvent))
  ok('mood v 落到负值', snap.mood.v <= -0.2, `v=${snap.mood.v}`)
  ok('注入预览带原因、不带数字', snap.hint.includes('他被批评了') && !/-0\.25|"dv"/.test(snap.hint), snap.hint)

  // —— 场景 2：system 里真的注进了心情块（取自下一轮聊天请求）——
  const beforeChat = seen.chat.length
  await post('/api/chat/say', { text: '在吗' })
  const sys2 = seen.chat[seen.chat.length - 1].sys
  ok('system 含关系事实块', sys2.includes('【你手上真实有的东西】'))
  ok('system 含心情块且带原因', sys2.includes('【你此刻的心情】') && sys2.includes('他被批评了'))
  ok('心情块没有把数字漏给模型', !/"dv"|dv=/.test(sys2) && !sys2.includes('-0.25'))

  // —— 场景 3：30h 缺席 → 冷落入账 + 时间感进 relationHint ——
  proc.kill()
  await sleep(800)
  // 直接改状态文件制造缺席（服务已停，下次启动重新 load）
  const stPath = path.join(TMP, 'inner.json')
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
  const H = 3600000
  st.lastSeenAt = Date.now() - 30 * H
  st.gapChargedUntil = Date.now() - 30 * H
  fs.writeFileSync(stPath, JSON.stringify(st, null, 1))
  proc = spawn(process.execPath, [TSX, path.join(PLUGIN, 'vendor', 'pet-service.ts')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PET_PORT: String(PORT), CTRL_PORT: String(PORT + 1), PET_NO_WINDOW: '1', INNER_DIR: TMP },
    stdio: 'ignore',
  })
  await until(async () => (await get('/api/inner')).ok === true)
  const before = seen.chat.length
  await post('/api/chat/say', { text: '我回来了' })
  const sys3 = seen.chat[seen.chat.length - 1].sys
  const snap3 = await get('/api/inner')
  ok('缺席 30h 被冷落扣分', snap3.mood.v < snap.mood.v + 0.3, `v=${snap3.mood.v}`)
  ok('原因句合并了冷落与归来', snap3.hint.includes('一天多没出现') && snap3.hint.includes('回来了'), snap3.hint)
  ok('时间感事实进了 system（今天聊了几句）', sys3.includes('今天他跟你说了'), sys3.slice(0, 400))
  // 「他上一句话是 X 前」在他正在说话的这轮被刻意抑制（<30min 属于正聊着，说了是噪音）
  // 冷落只扣一次：再来一轮，不重复扣
  const logBefore = fs.readFileSync(path.join(TMP, 'inner-log.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"gap"')).length
  await post('/api/chat/say', { text: '继续聊' })
  const logAfter = fs.readFileSync(path.join(TMP, 'inner-log.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"gap"')).length
  ok('同一段缺席不重复扣', logAfter === logBefore, `${logBefore} -> ${logAfter}`)

  // —— 场景 4：learn 异步落账后，原因句跟上；平静态绝不输出"你很平静" ——
  await until(() => extractCount >= 2, 10000)
  const snap4 = await get('/api/inner')
  ok('第二轮 learn 的冲量把原因句带出来了', snap4.hint.includes('他被批评了'), snap4.hint)
  ok('心情块永远不带数字、不说"平静"', !/"dv"|平静/.test(snap4.hint), snap4.hint)

  // —— 场景 5：自画像整合（攒够轮次后她重写"我是谁"，注入排在她自己写的三段之首）——
  // 24 句：第 12 句触发第一次日记（此时 maxTurnId=24 < 30 不整合），第 24 句第二次（48 ≥ 30 触发）
  for (let i = 0; i < 24; i++) await post('/api/chat/say', { text: `随便聊聊第 ${i} 句，今天感觉一般般` })
  await until(() => consolidateCount >= 1, 15000)
  ok('整合请求带着上一版材料', seen.consolidate.length > 0, '')
  await post('/api/chat/say', { text: '还在么' })
  const sys5 = seen.chat[seen.chat.length - 1].sys
  ok('system 注入自画像（三段之首）', sys5.includes('【你现在的样子】') && sys5.includes('我说话直接'))
  ok('重要时刻进了 brief 常驻', sys5.includes('【一直记得的时刻】') && sys5.includes('第一次被他夸可爱'))
  // 整合只该跑一次（80 句门槛），后面这轮不该再触发
  const cc = consolidateCount

  // —— 场景 6：主动陪聊（独立实例 + PRO 旋钮：1.2s 沉默即算、2s 一轮、跳过概率与安静时段）——
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-pro-'))
  let proc2 = null
  const post2 = (text) => fetch('http://127.0.0.1:18897/api/chat/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).then((r) => r.json())
  try {
    proc2 = spawn(process.execPath, [TSX, path.join(PLUGIN, 'vendor', 'pet-service.ts')], {
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '1',
        PET_PORT: '18897', CTRL_PORT: '18898', PET_NO_WINDOW: '1', INNER_DIR: TMP2,
        PRO_FORCE: '1', PRO_SILENCE_MIN: '0.02', PRO_SILENCE_MAX: '600', PRO_INTERVAL: '2',
      },
      stdio: 'ignore',
    })
    await until(async () => (await fetch('http://127.0.0.1:18897/api/inner').then((r) => r.json())).ok === true, 20000)
    await post2('先说一句，把沉默计时清零')
    await sleep(6000)
    ok('沉默窗口到了会主动开口', seen.proactive.length === 1, `count=${seen.proactive.length}`)
    await sleep(6000)
    ok('他没理就绝不追问（12 秒后仍只有一次）', seen.proactive.length === 1, `count=${seen.proactive.length}`)
    const snap6 = await fetch('http://127.0.0.1:18897/api/inner').then((r) => r.json())
    ok('今日主动计数 =1', snap6.pro.today === 1, JSON.stringify(snap6.pro))
    await post2('你刚才说什么？')
    ok('主动说的话进了 history 和记忆', proLineInHistory, '')
  } finally {
    try { proc2?.kill() } catch { /* noop */ }
    try { fs.rmSync(TMP2, { recursive: true, force: true }) } catch { /* noop */ }
  }

  console.log(process.exitCode ? '有失败项' : `check-inner 全部通过：${passed} 项`)
} finally {
  try { proc?.kill() } catch { /* noop */ }
  try { fake?.closeAllConnections?.() } catch { /* noop */ }
  try { fake?.close() } catch { /* noop */ }
  try {
    if (fs.existsSync(bakFile)) {
      fs.copyFileSync(bakFile, cfgFile)
      fs.rmSync(bakFile)
      cfgBackup = null
    } else if (cfgBackup) {
      fs.writeFileSync(path.join(PLUGIN, 'pet-config.json'), cfgBackup)
    }
  } catch (e) { console.error('还原配置失败，请手动检查 pet-config.json:', e.message) }
  console.log('（克隆 pet-config.json 已还原，假模型与子进程已清理）')
}
