/**
 * dsh-voice-picker —— DSH Cordis 插件入口（极薄）。
 *
 * 只做一件事：在本进程内起「音色工作台」HTTP 服务（默认 http://127.0.0.1:18768/），
 * 页面上可以试听 48 种 qwen3-tts 音色并一键切换小鲸鱼的说话声音。
 * 切换走小鲸鱼自己的 POST /api/config（pet-service 内部 writeCfg：内存即时生效 + 落盘），
 * 本插件不直接读写任何外部文件。
 *
 * 配置（cordis.patch.yml 里给）：
 *   port     监听端口，默认 18768（被占用自动 +1）
 *   petPort  小鲸鱼 PetServer 端口，默认 18765
 *   ctrlPort 小鲸鱼控制端口，默认 18766
 *   autoOpen 启动时自动开浏览器页面，默认 false（避免每次开机弹标签页）
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startPickerServer } from './server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 落盘日志：DSH 的插件 stdout 不一定可见（与 dsh-desktop-pet 同款做法）
const LOG = path.join(path.resolve(__dirname, '..'), 'voice-picker.log')
function log(...a) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`) } catch { /* noop */ }
}
log('plugin 模块已加载')

export const name = 'dsh-voice-picker'

export function apply(ctx, config = {}) {
  const cfg = { port: 18768, petPort: 18765, ctrlPort: 18766, autoOpen: false, ...config }
  const logger = ctx.logger || console
  let handle = null

  startPickerServer({
    port: cfg.port,
    petPort: cfg.petPort,
    ctrlPort: cfg.ctrlPort,
    autoOpen: cfg.autoOpen,
    log,
  })
    .then((h) => { handle = h })
    .catch((e) => {
      log('启动失败:', String((e && e.message) || e))
      logger.error?.('[voice-picker]', String((e && e.message) || e))
    })

  try {
    ctx.on('dispose', () => { try { handle?.close() } catch { /* noop */ } })
  } catch { /* noop */ }
}
