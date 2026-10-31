/**
 * DSH 桌宠插件（路线 B：原样复用 Coopanion 的鲸鱼）。
 *
 * 本插件本身极薄：
 *   1. 启动 vendor/pet-service.ts（一个独立 Node 子进程，直接跑 Coopanion
 *      原版 PetServer + web 渲染层）；
 *   2. 订阅 DSH 会话事件（turn/start、user/message、assistant/message、turn/end），
 *      映射成 say/thinking/listening/idle 指令，POST 给 pet-service 的本地控制端口；
 *   3. 暴露 ctx.pet 服务，供其它 DSH 插件直接驱动桌宠。
 *
 * 鲸鱼的渲染、骨骼、气泡、装扮全部来自 vendor/cortico-world-desktop-pet（AGPL-3.0），
 * 框架来自 vendor/node_modules/cortico（MIT）。本插件不修改其源码。
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..')

// —— 落盘日志：DSH 的插件 stdout 不一定可见，关键阶段写文件便于排查 ——
const LOG = path.join(PLUGIN_ROOT, 'plugin.log')
function log(...a) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`) } catch { /* noop */ }
}
log('plugin 模块已加载')

/**
 * 解析真正的 node 二进制。
 * 关键点：DSH Desktop 是 Electron，`process.execPath` 指向 Electron 主程序，
 * 用它去 spawn 一个 Node 脚本（tsx）会让 Electron 把脚本当主程序加载，PetServer 起不来。
 * 因此必须找到 DSH 工具链自带的 node（不是 Electron）。
 */
function resolveNodeBin() {
  // 当前进程已是普通 node 时直接用
  if (/[\\/]node(\.exe)?$/i.test(process.execPath)) return process.execPath
  // DSH / WorkBuddy 工具链自带的 node
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions')
  try {
    const vers = fs.readdirSync(base)
      .filter((v) => /^\d/.test(v))
      .sort()
      .reverse() // 取最新版本
    for (const v of vers) {
      const p = path.join(base, v, 'node.exe')
      if (fs.existsSync(p)) return p
    }
  } catch { /* 目录不存在时忽略 */ }
  // 最后兜底：依赖 PATH 中的 node（在 Electron 环境下通常不推荐，但作为保险）
  return 'node'
}

/**
 * 解析 tsx CLI（vendor/pet-service.ts 是 TypeScript，需要 tsx 来跑）。
 * 优先级：显式配置 > 插件自带 node_modules/tsx（npm install 自带）> 已装 Coopanion 的 tsx。
 * 全都找不到时返回 null —— start() 会给出可操作的提示而不静默失败。
 */
function resolveTsx(explicit) {
  const cands = [
    explicit,
    path.join(PLUGIN_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'D:/新建文件夹 (2)/Coopanion/resources/app/node_modules/tsx/dist/cli.mjs', // 常见安装位（本机开发机的路径，装了 Coopanion 就有现成 tsx）
  ].filter(Boolean)
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c } catch { /* noop */ }
  }
  return null
}

const DEFAULTS = {
  ctrlPort: 18766,
  petPort: 18765,
  autoOpen: true,
  // 留空 = 自动解析 tsx（插件 npm 自带 → Coopanion 安装位）；也可以手动指定绝对路径
  coopanionTsx: '',
}

export const name = 'dsh-desktop-pet'
export const Config = z.object({
  ctrlPort: z.number().default(DEFAULTS.ctrlPort).description('pet-service 控制端口（DSH 转发会话事件到此）'),
  petPort: z.number().default(DEFAULTS.petPort).description('PetServer 端口（桌宠 HTTP/WS）'),
  autoOpen: z.boolean().default(DEFAULTS.autoOpen).description('启动后自动用浏览器打开桌宠窗口'),
  coopanionTsx: z.string().default(DEFAULTS.coopanionTsx).description('tsx CLI 路径（留空自动解析：插件 npm 依赖 → Coopanion 安装位）'),
})

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const logger = ctx.logger || console
  let child = null
  let started = false

  // 桌面浮窗由 pet-service 自己拉起（借 Coopanion.exe 的 --pet-host 模式开透明置顶窗）。
  // 这里只负责把日志转出来，绝不再开浏览器标签 —— 用户要的是桌面上的鲸鱼。
  function start() {
    if (started) return
    started = true
    const nodeBin = resolveNodeBin()
    const tsx = resolveTsx(cfg.coopanionTsx)
    const petService = path.join(PLUGIN_ROOT, 'vendor', 'pet-service.ts')
    if (!tsx) {
      const hint = '找不到 tsx（pet-service.ts 需要 TypeScript 运行器）。'
        + '请在插件目录执行 npm install（依赖里自带 tsx），'
        + '或在 cordis.patch.yml / 插件配置里把 coopanionTsx 指向一个现成的 tsx/dist/cli.mjs。'
      log('[pet] ' + hint)
      console.error('[dsh-desktop-pet] ' + hint)
      logger.error?.('[pet] ' + hint)
      return
    }
    log('启动 pet-service：node =', nodeBin, '| tsx =', tsx, '| 脚本 =', petService)
    child = spawn(nodeBin, [tsx, petService], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, PET_PORT: String(cfg.petPort), CTRL_PORT: String(cfg.ctrlPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d) => {
      const s = d.toString()
      logger.info?.('[pet]', s.trim())
      if (/\[window\]/.test(s) || /\[chat\]/.test(s) || /未开浮窗/.test(s)) log('[pet]', s.trim())
    })
    child.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) { log('[pet-err]', s); logger.warn?.('[pet-err]', s); console.error('[pet-err]', s) } })
    child.on('error', (e) => { log('[pet] spawn error:', String(e)); console.error('[pet] spawn error:', String(e)); logger.error?.('[pet] spawn error:', String(e)) })
    child.on('exit', (code) => { log('[pet] 子进程退出，code=', code); logger.warn?.('[pet] 子进程退出，code=', code) })
  }

  async function drive(action, extra = {}) {
    try {
      await fetch(`http://127.0.0.1:${cfg.ctrlPort}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
    } catch {
      /* 服务尚未就绪时静默丢弃 */
    }
  }

  function textOf(msg) {
    const c = msg?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('')
    return ''
  }

  // —— 订阅 DSH 会话事件，驱动桌宠 ——
  ctx.on('session/event', (_session, event) => {
    if (!event || !event.type) return
    switch (event.type) {
      case 'turn/start':
        void drive('thinking')
        break
      case 'user/message':
        void drive('listening')
        break
      case 'assistant/message': {
        const t = textOf(event.message)
        if (t) void drive('say', { text: t })
        break
      }
      case 'turn/end':
        void drive('idle')
        break
    }
  })

  // —— 暴露服务，其它插件可直接驱动桌宠 ——
  try {
    ctx.provide('pet', {
      say: (text) => drive('say', { text }),
      act: (actions) => drive('act', { actions }),
      status: (s) => drive(s),
    })
  } catch {
    /* 未声明服务时忽略 */
  }

  start()
  try {
    ctx.on('dispose', () => { try { child?.kill() } catch { /* noop */ } })
  } catch { /* noop */ }
}
