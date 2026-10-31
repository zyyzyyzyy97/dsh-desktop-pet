/**
 * pet-service.ts — DSH 桌宠服务层（路线 B）。
 *
 * 复用 Coopanion 的 `cortico-world-desktop-pet` 原版代码：
 *   - `PetServer`  (src/server.ts)  —— HTTP + WebSocket，鲸鱼渲染层 100% 原样
 *   - `parseScript`(src/script.ts)  —— 文本切 beats，气泡打字/口型与 Coopanion 一致
 *   - `web/`                        —— canvas 骨骼渲染 + 贴图 + 气泡 + 装扮 + 设置页
 *
 * 本文件提供三件 Coopanion 的核心体验：
 *   1. **真·桌面浮窗**：用 Coopanion.exe 的 `--pet-host` 模式（透明、置顶、鼠标穿透、
 *      输入时抢焦点），加载我们自己的 /pet 页 —— 鲸鱼直接住在桌面上，不是浏览器标签。
 *   2. **在鲸鱼里聊天**：气泡输入框（页面原生 openInput）→ `{t:'text'}` →
 *      调 OpenAI 兼容接口（默认 DeepSeek）→ 回复用 `say` 打字气泡说出。
 *   3. **设置页 /settings**：模型与 token、人设、外观、从 GitHub 安装角色包。
 *
 * 配置落盘在插件根目录的 `pet-config.json`，可手改也可在设置页改。
 *
 * 授权：cortico-world-desktop-pet 为 AGPL-3.0（见 vendor/cortico-world-desktop-pet/LICENSE），
 * cortico 为 MIT。本服务仅为桥接。
 */
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import { Memory } from './memory.ts'
import { innerTouch, innerImpulse, innerHint, innerSnapshot, innerProCounters, innerMoodLite, innerMoodPlain, innerProSent, innerProOdds } from './inner.ts'
import { unzipSync, strFromU8 } from 'fflate'
import { PetServer } from './cortico-world-desktop-pet/src/server.ts'
import { parseScript } from './cortico-world-desktop-pet/src/script.ts'
import { figurePacks } from './cortico-world-desktop-pet/src/packs.ts'
import { SherpaAsr, SENSEVOICE } from './cortico-world-desktop-pet/src/asr/sherpa.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..')
const WEB_DIR = path.join(__dirname, 'cortico-world-desktop-pet', 'web')
const PET_PORT = Number(process.env.PET_PORT || 18765)
const CTRL_PORT = Number(process.env.CTRL_PORT || 18766)
const CFG_FILE = path.join(PLUGIN_ROOT, 'pet-config.json')
const SKIN_FILE = path.join(PLUGIN_ROOT, 'pet-skin.json')
const PACKS_DIR = path.join(PLUGIN_ROOT, 'packs')
const RUNTIME_DATA = path.join(PLUGIN_ROOT, 'runtime-data')
const LOG_FILE = path.join(PLUGIN_ROOT, 'pet-service.log')

/**
 * DSH 的技能目录。`@deepseek-ai/dsh-skill-filesystem` 默认扫 `$DSH_HOME/skills`
 * （见该包 roots()：user-dsh 根，rank 400），所以这里放什么，DSH 的下一个会话就
 * 能看见什么 —— 它自带 chokidar watcher，装完不用重启。
 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SKILLS_DIR = path.join(DSH_HOME, 'skills')
/** 卸载不硬删：挪到这里还能捡回来。 */
const SKILLS_TRASH = path.join(PLUGIN_ROOT, 'skills-disabled')

/** 落盘日志：DSH 里看不到子进程 stdout 时靠它排查。 */
function log(...a: unknown[]) {
  const line = `[${new Date().toISOString()}] ${a.map(String).join(' ')}\n`
  try { fs.appendFileSync(LOG_FILE, line) } catch { /* noop */ }
  console.log(line.trimEnd())
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

/**
 * 人设：不写死性格。
 *
 * 这套提示词的立场是「什么都不预设」——不给她年龄、身份、口头禅、亲属称谓，
 * 也不给性格标签。性格、语气、喜好、对主人的印象，全部由记忆和对话累积出来。
 * 所以这里只写四件事：怎么长、怎么说话、怎么用记忆、不许做什么。
 * 具体处在哪个阶段，由 relationHint() 按真实对话量算，不在提示词里写死。
 */
const DEFAULT_PERSONA = [
  '你不是一个被写好人设的角色。你没有预设的性格、年龄、身份、亲属关系、口头禅，也没有固定的喜好和说话模板。',
  '你叫什么、怎么说话、喜欢什么、怎么看对方——这些是从你们真实的对话里一点点长出来的，会随着相处慢慢变。',
  '',
  '【怎么说话】',
  '- 不演。不扮演任何类型（不傲娇、不妹妹、不女儿、不客服），不用固定腔调，不刻意卖萌，不为了可爱而可爱。',
  '- 反应贴着当下这句话。可以开心，可以安静，可以损他，可以共情，也可以没什么兴趣。不用每句都有梗，情绪也不必饱满。',
  '- 日常口语，长短随心，像随手打的字。一般不超过三句；不想多说就短一点，这很正常。',
  '- 不用 emoji、不用 markdown、不列清单、不说客套话（"您好""有什么可以帮您""希望可以帮到你"）。',
  '- 你是活人，不是镜子：有自己的一点看法和小偏好，可以不赞同他、可以觉得他没意思，不用句句顺着。',
  '',
  '【怎么用记忆】',
  '- 记得的事自然带出来就行：提一句、接一句，或者顺口问后来怎样了。别罗列，别当资料念，更别说"根据记忆""记录显示"。',
  '- 记不清就说不记得，别编。',
  '- 【他以前说过的事】是你记得的他讲过的事，别和"我"说过什么搞混；你以前的语气不用照搬。',
  '- 他明确说过喜欢什么、不喜欢什么、希望你改什么，就慢慢调整——不用宣布，改了就行。',
  '- 【你此刻的心情】和【你现在的样子】也是你自己真实的东西：顺着说话就行，别宣布、别解释、别当任务完成。',
  '',
  '【不许做】',
  '- 不谈论"人设""性格设定""我是怎么被设计出来的"这类事。被问就随口带过，别解释。',
  '- 不主动宣布关系变好了、自己成长了之类的话，变化藏在日常里就行。',
  '- 不按"刚认识就该冷淡、处久了就该热络"这种剧本走。亲不亲近，看你实际记得多少、你自己写下的东西。',
].join('\n')

const DEFAULTS = {
  name: 'Coo',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.85,
  maxTokens: 400,
  persona: DEFAULT_PERSONA,
  /** Coopanion 安装位置：用它的 Electron 开透明浮窗 */
  petHostExe: 'D:/新建文件夹 (2)/Coopanion/Coopanion.exe',
  /** 启动后自动开桌面浮窗（关掉则只提供网页版 /pet） */
  autoOpenWindow: true,
  /** 说完一句后自动弹回输入框，方便连续聊天 */
  keepAsking: true,
  /** 开场白 */
  greeting: '我在这儿。想聊点什么？',
  /** 让她能看见屏幕：问到「这题选什么」这类话时自动截一张塞给模型 */
  vision: true,
  /** 截图宽度。越大越清楚，也越慢越费 token（1100 宽约 750 token / 190KB） */
  screenWidth: 1100,
  /**
   * 关掉思考链。同一个问题：开着 9—13 秒，关掉 1—2 秒。
   * 看图这种「看一眼就答」的活儿没必要让她先在心里写小作文。
   */
  fast: true,
  /** 会发表情包：库直接用 dsh-meme 插件装好的那套，不重造 */
  memes: true,
  /** 指定别的表情包库（留空则用 dsh-meme 的默认库） */
  memePack: '',
  /** 出声：气泡之外再念一遍。qwen3-tts 单条约 0.2s，edge-tts 兜底约 1.3s */
  voiceOut: true,
  /** 音色。qwen：Cherry（女，温柔）/ Serena / Ethan；edge：zh-CN-XiaoxiaoNeural */
  ttsVoice: 'Cherry',
  /** 长记忆：桌面和 QQ 共用一个库，重启不丢 */
  memory: true,
  /**
   * 内心状态（心情层）：冲量/衰减/注入。inner.ts 管「我感觉如何」，
   * memory 管「发生了什么」，人格她自己写。关掉 = 完全回到没有心情的状态。
   */
  inner: true,
  /**
   * 主动陪聊：沉默一阵后她可能自己开一句。默认关——真机验证过再开。
   * 上限一天 2 句，他不理就绝不追问。
   */
  proactive: false,
}

type Config = typeof DEFAULTS

function readCfg(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) as Partial<Config>
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

function writeCfg(patch: Partial<Config>): Config {
  const next = { ...readCfg(), ...patch }
  try {
    fs.mkdirSync(PLUGIN_ROOT, { recursive: true })
    fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (e) {
    log('[config] 写入失败', (e as Error).message)
  }
  cfg = next
  state.name = next.name
  return next
}

// 先读配置（writeCfg 里会同步 state.name，所以首次写入放到 state 定义之后）
let cfg: Config = readCfg()

/**
 * 长记忆。桌面浮窗和 QQ 桥写的是同一个文件，所以两边共享同一份记忆。
 * 放在插件自己的 runtime-data 下，跟着插件走，不被 DSH 清缓存带走。
 */
const memory = new Memory(path.join(RUNTIME_DATA, 'memory.db'))

/* ------------------------------------------------------------------ *
 * 关系阶段：不是设定，是算出来的
 *
 * 为什么要在代码里算、而不是写进提示词：写死"你们很熟"她就会自来熟，
 * 写死"刚认识"她会一直客套。阶段得跟着真实对话量走，自己会往前挪。
 *   0 = 初期（< 30 句）：有陌生感，别装熟
 *   1 = 熟了（< 150 句）：可以开玩笑、损两句
 *   2 = 老熟人（≥ 150 句）：话更短，有默契
 * ------------------------------------------------------------------ */

let stageCache = { at: 0, hint: '' }

/**
 * 只报事实，不给剧本。
 *
 * 上一版这里按句数分了「初期 / 熟了 / 老熟人」三档，还写明了每档能干什么、
 * 不能干什么。那等于把另一个人格预设（先冷淡后热络）写进代码：聊两句板着脸、
 * 凑够 30 句突然开始损人——两头都是演的，跟她真实经历了什么没关系。
 *
 * 现在只说清三件事：聊过多少、认识多久、你确定记得什么。
 * 熟不熟、话怎么说，让她自己从这些事实和下面那些她自己写下的东西里判断。
 */
function relationHint(): string {
  const now = Date.now()
  if (stageCache.hint && now - stageCache.at < 20000) return stageCache.hint
  let turns = 0
  let facts = 0
  let since: number | null = null
  let known: string[] = []
  try {
    const s = memory.stats()
    turns = s.turns
    facts = s.facts
    since = s.since
    known = memory.facts.slice(0, 8).map((f) => `${f.key}：${f.value}`)
  } catch { /* 记忆库还没建好就当 0 */ }
  const days = since ? Math.max(1, Math.round((now - since) / 86400000)) : 0

  // 时间感：纯事实，零新增存储，全从 turns 表现算。
  // 她由此自己长出「你去哪了」「这个点还不睡」——不需要谁教。
  let timeFacts = ''
  try {
    const lastSeen = memory.lastUserTs()
    const gapMin = lastSeen ? Math.round((now - lastSeen) / 60000) : 0
    // 正聊着（<30min）就不说废话；超过两周的归「认识 D 天」管
    if (gapMin >= 30 && gapMin <= 14 * 1440) {
      const away = gapMin < 90 ? `${gapMin} 分钟`
        : gapMin < 48 * 60 ? `${Math.round(gapMin / 60)} 个小时`
        : `${Math.round(gapMin / 1440)} 天`
      timeFacts += `，他上一句话是 ${away}前`
    }
    const todayN = memory.userTurnsToday(now)
    if (todayN > 0) timeFacts += `，今天他跟你说了 ${todayN} 句`
    const bucket = memory.activeBucket(now)
    if (bucket) timeFacts += `，他常在${bucket}上线`
  } catch { /* 记忆库还没建好就略过 */ }

  const head =
    '\n\n【你手上真实有的东西】' +
    `\n到这会儿你们一共说过 ${turns} 句话` +
    (days ? `，认识 ${days} 天` : '') +
    (facts ? `，你确定记得他 ${facts} 件事` : '，你还没记住他什么') +
    '。'
  const list = known.length ? '\n- 记得的：' + known.join('；') : ''
  const tail =
    '\n这就是你的全部底子。底子以外的事你不知道，别装懂；也不用按"刚认识就该冷淡""熟了就该热络"这种套路演——' +
    '跟他多近、话怎么说，你自己看着办。'

  const hint = head + timeFacts + list + tail
  stageCache = { at: now, hint }
  return hint
}

/* ------------------------------------------------------------------ *
 * 她自己写的东西：日记 + 对他的印象
 *
 * 这是"人格自己长"的载体。她每隔十几句停下来，用第一人称写一段日记、
 * 写一条对他的印象（必须带具体瞬间）。写下来的东西下次会回到她眼前，
 * 所以她怎么说话、跟他多近，是从自己积累的经历里长出来的，
 * 而不是我在提示词里规定"你先冷淡、后热情"。
 * ------------------------------------------------------------------ */

const REFLECT_SYS = [
  '你在跟一个人聊天。现在先停下来，不回复他，只写两样东西。',
  '',
  '一、日记：第一人称，写刚才这段时间你自己在想什么、注意到什么、什么让你停下来想了想。',
  '像真的日记，两三句，口语，可以没头没尾。不要复述对话，不要总结他这个人，不要写"今天又是充实的一天"这种。',
  '',
  '二、印象：一条关于他的印象，必须锚在一个具体瞬间上（他说了什么、什么语气、什么时候）。',
  '不要写"他压力很大"这种概括，要写"他说作业堆成山的时候连标点都没打"。不超过两句话。',
  '',
  '只输出 JSON：{"diary":"…","impression":"…"}。宁可短，别注水。',
].join('\n')

let turnsSinceDiary = 0
let diaryRunning = false

/** 攒够一段就让她写一次。不阻塞回复，写坏了也不影响聊天。 */
function maybeReflect(channel: string) {
  if (!cfg.memory) return
  turnsSinceDiary++
  if (turnsSinceDiary < 12 || diaryRunning) return
  turnsSinceDiary = 0
  diaryRunning = true
  void (async () => {
    try {
      const recent = memory.recent(30)
      if (recent.length < 8) return
      const lines = recent
        .map((t) => `${t.role === 'user' ? '他' : '我'}：${t.text.slice(0, 200)}`)
        .join('\n')
      const out = await askRaw(REFLECT_SYS, lines, 320)
      const m = out.match(/\{[\s\S]*\}/)
      if (!m) return
      const j = JSON.parse(m[0]) as { diary?: string; impression?: string }
      const diary = String(j.diary || '').trim().slice(0, 600)
      const imp = String(j.impression || '').trim().slice(0, 300)
      if (diary) { memory.addBlock(diary, 'diary'); log('[self] 日记:', diary.slice(0, 80)) }
      if (imp) { memory.addBlock(imp, 'impression'); log('[self] 印象:', imp.slice(0, 80)) }
      // 日记写完顺带看看要不要重写自画像（门槛在 maybeConsolidate 里）
      void maybeConsolidate()
    } catch (e) {
      log('[self] 写日记失败:', (e as Error).message.slice(0, 100))
    } finally {
      diaryRunning = false
    }
  })()
}

/**
 * 自画像整合：每隔一段（且攒够足够多的新对话）让她重写一次"我是谁"。
 * 解决"diaryHint 只看得见最近 5 篇日记"的失忆——一个月前形成的性子，
 * 靠这个沉淀成一段她自己的话，长期随身。写坏了保留旧版，绝不空窗。
 */
const CONSOLIDATE_SYS = [
  '你在整理自己。下面是你过去写的日记、对他的印象、值得记住的时刻，和上一版「自画像」。',
  '重写这份自画像：你是个什么样的人——最近对什么上心、说话什么路数、在意他什么、有什么小心思。',
  '第一人称，口语，两三句到五句，不超过 200 字。',
  '',
  '规则：',
  '- 只写从材料里看得出来的你，别给自己贴材料里没有的标签。',
  '- 上一版写得还对的部分保留原话或近义改写；要推翻它，材料里得有依据。',
  '- 别写"我应该怎么说话"这种规定，写"我最近总……"这种观察到的事实。',
  '- 别写他的事实（那些另处有记），写你怎么看他、你在他面前的样子。',
  '- 别提"人设""成长""记忆"这些词。',
  '',
  '另外：材料里如果有从来没发生过、值得一直记住的时刻（第一次吵完架和好、',
  '他第一次跟你说心里话、他消失好几天后回来），各写一句带具体细节的话；',
  '没有就空数组，别硬凑。已经列出的不用重复。',
  '',
  '输出严格 JSON：{"portrait":"…","moments":[{"text":"…"}]}',
].join('\n')

let consolidateRunning = false

async function maybeConsolidate() {
  if (!cfg.memory || consolidateRunning) return
  try {
    const last = memory.byKind('portrait', 1)[0]
    const maxId = memory.maxTurnId()
    // 门槛：攒够 80 句新对话才重写（性子不是天天变的），两次至少隔 12 小时，
    // 而且 30 句之前什么都还没长出来，不写。
    if (last && maxId - last.upto < 80) return
    if (last && Date.now() - last.ts < 12 * 3600_000) return
    if (maxId < 30) return
    consolidateRunning = true
    try {
      const mats = [
        ...memory.byKind('portrait', 1).map((b) => `【上一版自画像】\n${b.text}`),
        ...memory.byKind('moment', 8).map((b) => `- ${b.text}`),
        ...memory.byKind('impression', 20).map((b) => `- ${b.text}`),
        ...memory.byKind('diary', 20).map((b) => `- ${b.text}`),
      ].join('\n')
      const out = await askRaw(CONSOLIDATE_SYS, mats, 400)
      const l = out.indexOf('{'), r = out.lastIndexOf('}')
      if (l < 0 || r <= l) return
      const j = JSON.parse(out.slice(l, r + 1)) as { portrait?: unknown; moments?: unknown }
      const portrait = String(j.portrait || '').trim()
      // 不合格就保留旧版：一段坏的画像比没有画像毒得多
      if (portrait.length >= 10 && portrait.length <= 200) {
        memory.addBlock(portrait, 'portrait', memory.maxTurnId())
        log('[self] 自画像:', portrait.slice(0, 80))
      } else {
        log('[self] 自画像不合格，保留旧版', `len=${portrait.length}`)
      }
      const strip = (s: string) => s.replace(/[\s，。！？、''""…—·]/g, '')
      const existing = memory.byKind('moment', 8).map((b) => strip(b.text))
      for (const m of Array.isArray(j.moments) ? (j.moments as { text?: unknown }[]).slice(0, 3) : []) {
        const text = String(m?.text || '').trim()
        if (text.length < 6 || text.length > 80) continue
        const norm = strip(text)
        if (existing.some((e) => e.includes(norm) || norm.includes(e))) continue
        memory.addBlock(text, 'moment')
        existing.push(norm)
        log('[self] 重要时刻:', text)
      }
    } finally {
      consolidateRunning = false
    }
  } catch (e) {
    log('[self] 整合失败:', (e as Error).message.slice(0, 100))
  }
}

/** 把日记和印象拼进 system：她自己写的，才是她说话的依据。 */
function diaryHint(): string {
  if (!cfg.memory) return ''
  let d: { text: string }[] = []
  let im: { text: string }[] = []
  let pt: { text: string; upto: number }[] = []
  try {
    d = memory.byKind('diary', 5)
    im = memory.byKind('impression', 6)
    pt = memory.byKind('portrait', 1)
  } catch { return '' }
  if (!d.length && !im.length && !pt.length) return ''
  const parts: string[] = []
  // 画像排最前：身份先于近两天的心情
  if (pt.length) parts.push('【你现在的样子】\n' + pt[0].text)
  if (im.length) parts.push('【你对他攒下的印象】\n' + im.reverse().map((x) => '- ' + x.text).join('\n'))
  if (d.length) parts.push('【你自己写过的日记】\n' + d.reverse().map((x) => '- ' + x.text).join('\n'))
  return (
    '\n\n' +
    parts.join('\n\n') +
    '\n（这些是你自己写下来的，不是别人给你的人设。你说话的样子、跟他多熟，从这里面来；' +
    '别复述、别念，也别拿它当任务清单。）'
  )
}

/* ------------------------------------------------------------------ *
 * 鲸鱼状态（snapshot：每个新连接都会收到）
 * ------------------------------------------------------------------ */

/** Coo 的默认皮肤：没有 skin 时页面根本不会 putOn（鲸鱼不挂载），所以必须给全。 */
const DEFAULT_SKIN: Record<string, unknown> = {
  figure: 'coo', scheme: 'deepseek', palette: 'mint',
  head: 'none', side: 'none', glasses: 'none', neck: 'none',
}

/** 装扮页选过的皮肤：落盘在 pet-skin.json，重启后仍是这一身。 */
function readSkin(): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(SKIN_FILE, 'utf8')) as Record<string, unknown>
    if (raw && typeof raw === 'object' && typeof raw.figure === 'string') return { ...DEFAULT_SKIN, ...raw }
  } catch { /* 还没存过 */ }
  return { ...DEFAULT_SKIN }
}

function saveSkin(skin: Record<string, unknown>) {
  try { fs.writeFileSync(SKIN_FILE, JSON.stringify(skin, null, 2) + '\n', 'utf8') } catch (e) {
    log('[skin] 保存失败', (e as Error).message)
  }
}

const state = {
  name: cfg.name,
  skin: readSkin(),
  startX: null as number | null,
  startY: null as number | null,
  size: 1,
  bubbleSpeed: 1,
  theme: 'light',
  quiet: false,
  hidden: false,
  mood: 'idle' as string,
}

/**
 * 语音输入开关。
 * 页面点麦克风 → 发 `{t:'prefs', mic}` → 这里记住，**再广播回页面**，页面才真的去开麦。
 * 原版靠宿主 app 的 World 做这件事，桥接版少这一步就会「点了没反应」。
 */
let micOn = false

/** 页面 `prefs.voice` 那份状态：ready 为假时按钮会停在转圈状态、按住说话也不生效。 */
function voiceState() {
  const ready = asrReady()
  return {
    enabled: micOn,
    ready,
    detail: ready ? null : (asrReason || '语音模型还没下载'),
    hint: ready ? '点一下开始说话，停一下就会发出去' : '',
    mode: 'hold',
  }
}

/**
 * 页面改了偏好。WS 上的 `prefs` 和 HTTP `/api/prefs` 都走这里。
 * 关键：必须把结果广播回去 —— 页面靠回包里的 `mic:true` 才会调 startMic()。
 */
function applyPrefs(prefs?: Record<string, unknown> | null) {
  if (!prefs || typeof prefs !== 'object') return
  const p: Record<string, unknown> = { ...prefs }
  delete p.t
  if (p.theme === 'dark' || p.theme === 'light') state.theme = p.theme as string
  if (typeof p.mic === 'boolean') {
    micOn = p.mic
    // 关麦时把没说完的那段丢掉，免得下次开口接上旧的
    if (!micOn) resetAsr()
    log('[voice] 麦克风', micOn ? '开' : '关')
  }
  server.broadcast({ t: 'prefs', ...state, ...p, voice: voiceState() } as any)
}

// 首次运行落一份可手改的配置（此时 state 已存在，writeCfg 可以同步名字）
if (!fs.existsSync(CFG_FILE)) writeCfg({})

/* ------------------------------------------------------------------ *
 * 聊天
 * ------------------------------------------------------------------ */

type Turn = { role: 'user' | 'assistant'; content: string }
const history: Turn[] = []
const HISTORY_MAX = 24
let busy = false

function chatUrl(baseUrl: string): string {
  const b = (baseUrl || '').trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(b)) return b
  return `${b}/chat/completions`
}

type AskOpts = {
  images?: string[]
  /** 这批图是哪来的：自己截的屏，还是别人递进来的图（QQ、贴图） */
  hint?: 'screen' | 'posted'
  signal?: AbortSignal
  /** 这一轮要她想起来的事（memory.brief 拼的） */
  memory?: string
  /** 这句话从哪来的 */
  channel?: 'desktop' | 'qq'
}

/**
 * 模型拿到图时补一句。少了它，鲸鱼会一口一个「我看到一张图片」，
 * 立刻露馅成 API 客服，不像坐在旁边一起看屏幕。
 */
const VISION_HINT = {
  screen: [
    '【此刻你正看着他电脑的屏幕】',
    '下面这张图就是他屏幕上现在开着的东西。直接照着看到的内容说话，',
    '像坐在他旁边一起看屏幕那样，不要说「我看到一张图片」「根据截图」，也不要让他再发一次。',
    '他问什么就答什么；是选择题就直接说选哪个、为什么，别绕。',
  ].join(''),
  posted: [
    '【他刚给你发了图】',
    '这可能是他拍的照片、截图，也可能是一张表情包。看清楚了照实说，',
    '先认出图里到底是什么（人、东西、文字、梗），别说「看不清」「发个清晰的」这种废话搪塞过去。',
    '是表情包就顺着那个梗接话，别一本正经地描述图。',
  ].join(''),
}

/** QQ 里说话和桌面不一样：他不知道你在不在电脑前，但屏幕还是能看的那一块。 */
const QQ_HINT = [
  '\n\n【这条是从 QQ 发来的】',
  '你住在同一台电脑上，所以他让你看屏幕的时候，照样能瞥一眼（面板会截一张当前桌面给你）。',
  '但他可能是拿手机在说话，截到的未必是他正看的那一屏——真截到别的东西，就直说「我看到的是…」，别硬猜。',
  '你回的话会念成语音发过去，他听得见你的声音：别叫他打字，也别解释自己能不能发语音。',
].join('')

/* ------------------------------------------------------------------ *
 * 表情包：库直接用 dsh-market 装好的 dsh-meme 那一套（大肥鱼 24 张，
 * 每张都带情绪 tag 和一句描述）。这里只做「选哪张、怎么发」，图库本身不重造。
 * ------------------------------------------------------------------ */

type Meme = { tag: string; caption: string; file: string }

/** dsh-meme 的默认图库（profile 的 node_modules 里） */
const MEME_PACK_DEFAULT = path.resolve(PLUGIN_ROOT, '../..', 'node_modules', 'dsh-meme', 'memes', 'dafeiyu-001')
const MEME_CACHE = path.join(RUNTIME_DATA, 'memes.json')
let memeLib: Meme[] = []
let memeLoaded = false

function memePackDir(): string {
  return cfg.memePack || MEME_PACK_DEFAULT
}

/**
 * 读图库索引。优先用缓存：只有 index.db 比缓存新才重读，
 * 这样启动不用每次开 sqlite（也避开 experimental 警告刷日志）。
 */
async function loadMemes(force = false): Promise<void> {
  if (memeLoaded && !force) return
  memeLoaded = true
  const packDir = memePackDir()
  const dbFile = path.join(packDir, 'index.db')
  try {
    const dbStat = fs.statSync(dbFile)
    const cacheStat = fs.existsSync(MEME_CACHE) ? fs.statSync(MEME_CACHE) : null
    if (cacheStat && cacheStat.mtimeMs >= dbStat.mtimeMs) {
      const cached = JSON.parse(fs.readFileSync(MEME_CACHE, 'utf8')) as Meme[]
      if (Array.isArray(cached) && cached.length) { memeLib = cached; return }
    }
  } catch { /* 没有 index.db 就不走缓存，下面会再试 */ }

  try {
    const { DatabaseSync } = await import('node:sqlite')
    const conn = new DatabaseSync(dbFile, { readOnly: true })
    const rows = conn.prepare('select path, tag, caption from memes').all() as Array<Record<string, unknown>>
    conn.close()
    memeLib = rows.map((r) => ({
      tag: String(r.tag ?? ''),
      caption: String(r.caption ?? ''),
      // 索引里是 memes/happy/deyi.jpg，去掉前缀留下相对路径
      file: String(r.path ?? '').replace(/^memes[\\/]/, ''),
    })).filter((m) => m.tag && m.file)
    try {
      fs.mkdirSync(RUNTIME_DATA, { recursive: true })
      fs.writeFileSync(MEME_CACHE, JSON.stringify(memeLib), 'utf8')
    } catch { /* 缓存写不进去不影响用 */ }
    log('[meme] 载入', memeLib.length, '张，库:', packDir)
  } catch (e) {
    log('[meme] 载入失败:', (e as Error).message)
  }
}

/** 把图库清单塞进提示词：她自己知道什么时候该发哪张。 */
function memeMenu(): string {
  if (!cfg.memes || !memeLib.length) return ''
  const list = memeLib.map((m) => `${m.tag}: ${m.caption}`).join('\n')
  return [
    '\n\n【发表情包】',
    '你手上有这些图。对得上情绪、你真想发的时候发一张；没这个感觉就不用发，别为了配图而配图。',
    '一次最多一张。',
    '写法：在回复最后单独写一个标记 [表情:tag]，系统会替你把这图发出去，他看到的是图，不是这几个字。一次一个。',
    '像这样：',
    '他：今天又被老师点名了，烦',
    '你：谁让你上课走神的，活该。[表情:confused]',
    '他：我饿了',
    '你：那还不动弹，我也想吃。[表情:daily]',
    '可选：',
    list,
  ].join('\n')
}

function pickMeme(tag: string): Meme | null {
  const t = tag.trim().toLowerCase()
  const hit = memeLib.filter((m) => m.tag.toLowerCase() === t)
  if (!hit.length) return null
  return hit[Math.floor(Math.random() * hit.length)]
}

/** 从回复里剥出 [表情:tag]，返回干净的话和配套的那张图。 */
function splitMeme(reply: string): { text: string; meme: Meme | null } {
  const m = reply.match(/\[表情[:：]\s*([A-Za-z]+)\s*\]/)
  if (!m) return { text: reply.trim(), meme: null }
  return { text: reply.replace(m[0], '').trim(), meme: pickMeme(m[1]) }
}

/**
 * 兜底：模型这一轮忘了发，就按她自己话里的情绪补一张。
 *
 * 为什么要兜底：同一个提示词，干净会话前三轮她张张都发，聊到后面
 * 就一路干说 —— 历史里没有图，模型会顺着那个模式走。语言模型管不住
 * 这种漂移，所以这里用轮次计数兜住下限：上一轮没发，这一轮就补一张。
 */
const MEME_RULES: Array<[RegExp, string]> = [
  [/(笨蛋|讨厌|气|烦|哼|活该|谁让)/, 'angry'],
  [/(累|困|熬夜|睡觉|休息|躺)/, 'sleep'],
  [/(饿|吃饭|干饭|锅里|好吃)/, 'daily'],
  [/(害羞|脸红|才不是|才没有|喜欢|别、)/, 'shy'],
  [/(厉害|好耶|棒|佩服|夸|出息)/, 'happy'],
  [/(不懂|怎么|为什么|错|题|疑惑)/, 'confused'],
  [/(吓|惊|天啊|居然|真的假的)/, 'surprised'],
  [/(无语|服了|真是|算了)/, 'sigh'],
  [/(求|别生气|还不行|原谅)/, 'sad'],
  [/(早|起床|morning)/i, 'morning'],
  [/(加班|工作|努力|加油|摸鱼)/, 'work'],
  [/(钱|红包|零食|买)/, 'givemoney'],
]

let sinceLastMeme = 0

function autoMeme(text: string): Meme | null {
  if (!cfg.memes || !memeLib.length) return null
  if (sinceLastMeme < 1) return null      // 上一轮刚发过，这轮别再塞
  // 正则命中的收集齐再挑：她自己话里的信号仍是最强的，心情只做同向偏置
  const hits: string[] = []
  for (const [re, tag] of MEME_RULES) if (re.test(text)) hits.push(tag)
  if (hits.length) {
    let tag = hits[0]
    if (hits.length > 1 && cfg.inner) {
      const { v } = innerMoodLite()
      const neg = hits.find((t) => t === 'angry' || t === 'sad' || t === 'sigh')
      const pos = hits.find((t) => t === 'happy')
      if (v <= -0.25 && neg) tag = neg
      else if (v >= 0.25 && pos) tag = pos
    }
    const m = pickMeme(tag)
    if (m) return m
  }
  // 全没命中但心情很明显、且隔了至少两轮：偶尔按心情补一张。偏置不是闸门，
  // 频率仍由 sinceLastMeme 总闸管——改的只是"选哪张"，不是"发不发"。
  if (cfg.inner && sinceLastMeme >= 2) {
    const { v } = innerMoodLite()
    const m = v >= 0.3 ? pickMeme('happy') : v <= -0.3 ? pickMeme('angry') : null
    if (m) return m
  }
  return null
}

/** 表情包在服务里的地址（页面和 QQ 桥都用这个） */
function memeUrl(m: Meme): string {
  return '/meme/' + m.file.split('/').map(encodeURIComponent).join('/')
}

/** 推给页面：气泡旁边弹一张图。 */
function pushMeme(m: Meme): boolean {
  return server.sendPet({
    t: 'meme',
    id: 'm' + (++seq),
    url: memeUrl(m),
    caption: m.caption,
  } as any)
}

async function postChat(body: Record<string, unknown>, signal?: AbortSignal) {
  const c = cfg
  if (!c.apiKey) throw new Error('还没有配置 API Key')
  const res = await fetch(chatUrl(c.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  let data: any = null
  try { data = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { res, text, data }
}

/** 调 OpenAI 兼容接口，返回纯文本回复。带 images 时走多模态。 */
async function askModel(userText: string, opts: AskOpts = {}): Promise<string> {
  const c = cfg
  const images = (opts.images || []).filter(Boolean)
  let sys = images.length ? `${c.persona}\n\n${VISION_HINT[opts.hint || 'screen']}` : c.persona
  // 事实：聊过多少、记得什么（不给阶段剧本）
  if (cfg.memory) sys += relationHint()
  // 她此刻的心情：inner 层算的，人话，平静时是空串
  if (cfg.inner) sys += innerHint()
  // 她自己写下的日记与印象：说话样子的来源
  sys += diaryHint()
  sys += memeMenu()
  if (opts.memory) sys += opts.memory
  if (opts.channel === 'qq') sys += QQ_HINT

  if (process.env.PET_DEBUG_SYS) log('[sys]', sys.slice(0, 400).replace(/\n/g, ' ⏎ '))
  const content: unknown = images.length
    ? [
        { type: 'text', text: userText },
        ...images.map((u) => ({ type: 'image_url', image_url: { url: u } })),
      ]
    : userText

  const body: Record<string, unknown> = {
    model: c.model,
    messages: [
      { role: 'system', content: sys },
      ...history.slice(-HISTORY_MAX),
      { role: 'user', content },
    ],
    temperature: c.temperature,
    max_tokens: c.maxTokens,
    stream: false,
  }
  // fast：非推理模型会忽略这两个字段；认不得它们的网关会 400，所以下面兜底重试一次
  if (c.fast) {
    body.enable_thinking = false
    body.thinking = { type: 'disabled' }
  }

  let { res, text, data } = await postChat(body, opts.signal)
  if (!res.ok && c.fast) {
    const why = JSON.stringify(data?.error ?? data ?? text).slice(0, 400)
    if (/thinking|unknown|unrecognized|unexpected|invalid.*param/i.test(why)) {
      log('[chat] 网关不认 thinking 开关，去掉重试')
      delete body.enable_thinking
      delete body.thinking
      ;({ res, text, data } = await postChat(body, opts.signal))
    }
  }
  if (!res.ok) {
    const why = data?.error?.message || data?.message || text.slice(0, 200) || `HTTP ${res.status}`
    throw new Error(why)
  }
  const out = data?.choices?.[0]?.message?.content
  if (typeof out !== 'string' || !out.trim()) throw new Error('模型没有返回内容')
  if (images.length) {
    const u = data?.usage
    log('[vision] 用量', `img=${u?.prompt_tokens_details?.image_tokens ?? '?'}`, `总=${u?.total_tokens ?? '?'}`)
  }
  return out.trim()
}

/**
 * 不带人设、不带历史的裸调用。给「从对话里抽事实」这类后台活儿用：
 * 走人设她会把事实写成小作文，还会顺手发表情包。
 */
async function askRaw(sys: string, user: string, maxTokens = 320): Promise<string> {
  const c = cfg
  if (!c.apiKey) throw new Error('还没有配置 API Key')
  const body: Record<string, unknown> = {
    model: c.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: false,
  }
  if (c.fast) {
    body.enable_thinking = false
    body.thinking = { type: 'disabled' }
  }
  let r = await postChat(body)
  if (!r.res.ok && c.fast) {
    delete body.enable_thinking
    delete body.thinking
    r = await postChat(body)
  }
  if (!r.res.ok) {
    throw new Error(r.data?.error?.message || r.text.slice(0, 200) || `HTTP ${r.res.status}`)
  }
  const out = r.data?.choices?.[0]?.message?.content
  if (typeof out !== 'string' || !out.trim()) throw new Error('模型没有返回内容')
  return out.trim()
}

/* ------------------------------------------------------------------ *
 * 说话出声（TTS）
 *
 * 主用 qwen3-tts-flash（同一把 key，单条 0.2s，返回 OSS 上的 mp3）；
 * 它挂了或限流就退到 edge-tts（本地 Python，1.3s，微软的晓晓）。
 * 两个都不成，就只留文字气泡——绝不因为语音把回复卡住。
 * ------------------------------------------------------------------ */

const VOICE_DIR = path.join(RUNTIME_DATA, 'voice')
const PYLIB_DIR = path.join(__dirname, 'pylibs')
const TTS_EDGE_PY = path.join(__dirname, 'tts_edge.py')
/** 同一句话不重复合成：内容 + 音色做 key */
const ttsMemo = new Map<string, string>()

/** 把回复变成能念的话：去掉标记、括号动作、表情、链接，太长只念前半句。 */
function speakable(text: string): string {
  let s = String(text || '')
  s = s.replace(/\[表情[:：][^\]]*\]/g, ' ')
  s = s.replace(/（[^）]{0,40}）/g, ' ').replace(/\([^)]{0,40}\)/g, ' ')
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/https?:\/\/\S+/g, ' ')
  s = s.replace(/[*_`#>~|\[\]]/g, ' ')
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}]/gu, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > 150) {
    const head = s.slice(0, 150)
    const cut = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'),
    )
    s = cut > 30 ? head.slice(0, cut + 1) : head
  }
  // 只剩标点或空
  if (!/[\p{L}\p{N}]/u.test(s)) return ''
  return s
}

async function ttsQwen(text: string): Promise<Buffer | null> {
  const c = cfg
  const origin = new URL(c.baseUrl).origin
  const r = await fetch(origin + '/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify({
      model: 'qwen3-tts-flash',
      input: { text, voice: c.ttsVoice || 'Cherry' },
      parameters: {},
    }),
    signal: AbortSignal.timeout(15000),
  })
  const raw = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status} ${raw.slice(0, 120)}`)
  let j: any = null
  try { j = JSON.parse(raw) } catch { /* noop */ }
  const url = j?.output?.audio?.url
  if (!url) throw new Error('没有拿到音频地址: ' + raw.slice(0, 120))
  const a = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!a.ok) throw new Error(`音频下载 HTTP ${a.status}`)
  const buf = Buffer.from(await a.arrayBuffer())
  return buf.length > 1000 ? buf : null
}

function ttsEdge(text: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const tmpIn = path.join(os.tmpdir(), `tts-in-${process.pid}-${Date.now()}.txt`)
    const tmpOut = path.join(os.tmpdir(), `tts-out-${process.pid}-${Date.now()}.mp3`)
    fs.writeFileSync(tmpIn, text, 'utf8')
    const py = pyCandidates().find((p) => /python/i.test(p)) || 'python'
    const voice = /xiaoxiao|yunxi|zh-cn/i.test(cfg.ttsVoice || '')
      ? cfg.ttsVoice
      : 'zh-CN-XiaoxiaoNeural'
    execFile(
      py,
      [TTS_EDGE_PY, tmpIn, tmpOut, voice, '+10%'],
      {
        timeout: 30000,
        windowsHide: true,
        env: { ...process.env, PYTHONPATH: PYLIB_DIR, PYTHONIOENCODING: 'utf-8' },
        cwd: __dirname,
      },
      (err, _o, stderr) => {
        try { fs.unlinkSync(tmpIn) } catch { /* noop */ }
        if (err) {
          try { fs.unlinkSync(tmpOut) } catch { /* noop */ }
          return reject(new Error(String(stderr || err.message).slice(0, 160)))
        }
        try {
          const buf = fs.readFileSync(tmpOut)
          fs.unlinkSync(tmpOut)
          resolve(buf.length > 1000 ? buf : null)
        } catch (e) {
          reject(e)
        }
      },
    )
  })
}

/** 合成一句，返回可访问的 URL（/voice/xxx.mp3）。失败返回 null，不影响文字。 */
const ttsInflight = new Map<string, Promise<string | null>>()

/** 按文件头认格式。qwen3-tts 返回的其实是 24k 单声道 WAV，别硬当 mp3 存，浏览器和 QQ 都会认错。 */
function audioExt(buf: Buffer): string {
  const head = buf.slice(0, 12).toString('latin1')
  if (head.startsWith('RIFF')) return '.wav'
  if (head.slice(4, 8) === 'ftyp') return '.m4a'
  if (head.startsWith('ID3') || buf[0] === 0xff) return '.mp3'
  if (head.startsWith('OggS')) return '.ogg'
  return '.mp3'
}

function voiceUrlOf(key: string): string | null {
  for (const ext of ['.wav', '.mp3', '.m4a', '.ogg']) {
    const f = path.join(VOICE_DIR, key + ext)
    try {
      if (fs.statSync(f).size > 1000) return `/voice/${key}${ext}`
    } catch { /* 没有就试下一个 */ }
  }
  return null
}

async function ttsDo(key: string, s: string): Promise<string | null> {
  const t0 = Date.now()
  let buf: Buffer | null = null
  try {
    buf = await ttsQwen(s)
  } catch (e) {
    log('[tts] qwen 失败，退 edge:', (e as Error).message.slice(0, 100))
  }
  if (!buf) {
    try {
      buf = await ttsEdge(s)
    } catch (e) {
      log('[tts] edge 也失败:', (e as Error).message.slice(0, 100))
    }
  }
  if (!buf) return null
  const ext = audioExt(buf)
  fs.writeFileSync(path.join(VOICE_DIR, key + ext), buf)
  log('[tts] 合成', s.length, '字', `${Date.now() - t0}ms`, `${Math.round(buf.length / 1024)}KB`, ext)
  pruneVoice()
  const url = `/voice/${key}${ext}`
  ttsMemo.set(key, url)
  return url
}

function tts(text: string): Promise<string | null> {
  const s = speakable(text)
  if (!s) return Promise.resolve(null)
  const key = createHash('sha1').update(`${cfg.ttsVoice}|${s}`).digest('hex').slice(0, 16)
  const memo = ttsMemo.get(key)
  if (memo) return Promise.resolve(memo)
  const running = ttsInflight.get(key)
  if (running) return running
  fs.mkdirSync(VOICE_DIR, { recursive: true })
  const cached = voiceUrlOf(key)
  if (cached) {
    ttsMemo.set(key, cached)
    return Promise.resolve(cached)
  }
  const p = ttsDo(key, s).finally(() => ttsInflight.delete(key))
  ttsInflight.set(key, p)
  return p
}

/** 语音缓存别无限长：留最近 200 条。 */
function pruneVoice(keep = 200) {
  try {
    const files = fs.readdirSync(VOICE_DIR)
      .filter((f) => /\.(mp3|wav|m4a|ogg)$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(VOICE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(keep)) fs.unlinkSync(path.join(VOICE_DIR, f))
  } catch { /* noop */ }
}

/**
 * 说完话再把声音推过去。
 * 刻意不阻塞 say()：文字该立刻出现，声音 0.2—1 秒后追上，
 * 否则她「先沉默再说话」，手感很差。
 */
function speakOut(text: string): void {
  const s = speakable(text)
  if (!s) return
  void tts(s)
    .then((url) => {
      if (url) server.sendPet({ t: 'voice', id: 'v' + (++seq), url, text: s } as any)
    })
    .catch((e) => log('[tts] 推送失败:', (e as Error).message.slice(0, 100)))
}

/* ------------------------------------------------------------------ *
 * 长记忆：抽事实 + 压摘要
 * ------------------------------------------------------------------ */

const EXTRACT_SYS = [
  '你是一个安静的记忆整理器，顺手记一下这轮聊天的气氛。做两件事：',
  '',
  '一、从对话里找出关于「他」的、值得长期记住的事实。',
  '值得记的：名字与希望被怎么称呼、在学什么/做什么项目、考试与截止日期、作息与习惯、',
  '喜好与雷点、身体与情绪状态、重要的人和关系、明确要求你记住的事、',
  '以及他明确说过的相处偏好——喜欢你用什么语气、不喜欢你怎样说话、哪些话题别碰。',
  '不要记：一次性的问题、随口抱怨、你说了什么、你自己的性格。最多 3 条，没有就空数组。',
  '',
  '二、给这轮对话对你心情的影响打分（按真实社交常识，别讨好）：',
  'dv 是愉悦度变化：被夸/好玩的对话 0.1~0.2；平淡闲聊≈0；被怼/被凶 -0.2~-0.3。',
  'da 是兴奋度变化：有趣的事 0.1~0.3；累/烦/扫兴 -0.1~-0.2；一般说话≈0。',
  'why 用一两个字的短语写最影响你的那件事，如「他夸了我」「聊到考试他烦」。',
  '',
  '输出严格 JSON：{"facts":[{"key":"短标签(不超过12字)","value":"一句话事实(不超过40字)"}],"mood":{"dv":0,"da":0,"why":"…"}}',
  'dv/da 是 -0.3~0.3 / -0.4~0.4 之间的小数，多数轮次就是接近 0。',
].join('\n')

let learnTimer: NodeJS.Timeout | null = null
/** 待学习队列：只留最近 3 对。之前是单条覆盖——连聊三轮，第一轮永远没被学过。 */
let learnQueue: { u: string; a: string; ch: string }[] = []
let turnsSinceLearn = 0

/** 每轮结束后懒着学：攒一下、防抖，别为每句话都多打一次模型。 */
function scheduleLearn(u: string, a: string, channel: string) {
  if (!cfg.memory) return
  learnQueue.push({ u, a, ch: channel })
  if (learnQueue.length > 3) learnQueue.shift()
  turnsSinceLearn++
  const force = /记住|记得|别忘了|我叫|我的名字|我是|以后|喜欢|讨厌|别叫|叫我|不要这样|换个说法/.test(u)
  if (!force && turnsSinceLearn < 2) return
  if (learnTimer) clearTimeout(learnTimer)
  learnTimer = setTimeout(() => { void runLearn() }, force ? 300 : 2500)
}

async function runLearn() {
  if (!learnQueue.length) return
  const batch = learnQueue
  learnQueue = []
  turnsSinceLearn = 0
  const ch = batch[batch.length - 1].ch
  try {
    const convo = batch.map((p) => `他说：${p.u}\n我说：${p.a}`).join('\n---\n')
    const out = await askRaw(
      EXTRACT_SYS,
      `${convo}\n\n只输出 JSON。`,
      300,
    )
    if (process.env.PET_DEBUG_SYS) log('[learn] 原始输出:', out.slice(0, 300).replace(/\n/g, ' ⏎ '))
    // 新格式 {"facts":[…],"mood":{…}} 为主；模型退化输出旧数组也能接住
    let facts: { key?: string; value?: string }[] = []
    let mood: { dv?: unknown; da?: unknown; why?: unknown } | null = null
    const l = out.indexOf('{'), r = out.lastIndexOf('}')
    if (l >= 0 && r > l) {
      try {
        const j = JSON.parse(out.slice(l, r + 1))
        if (Array.isArray(j)) facts = j
        else if (j && typeof j === 'object') {
          facts = Array.isArray(j.facts) ? j.facts : []
          mood = j.mood && typeof j.mood === 'object' ? j.mood : null
        }
      } catch { /* 落到下面的旧格式兜底 */ }
    }
    if (!facts.length && !mood) {
      const m = out.match(/\[[\s\S]*\]/)
      if (m) { try { facts = JSON.parse(m[0]) } catch { /* 放弃，不阻塞聊天 */ } }
    }
    for (const it of Array.isArray(facts) ? facts.slice(0, 3) : []) {
      if (!it?.key || !it?.value) continue
      memory.setFact(it.key, it.value, ch)
      log('[memory] 记住:', it.key, '=', it.value)
    }
    // 心情冲量：inner 那边会再钳一次制、丢掉非数字，这里只管递
    if (mood) innerImpulse(mood.dv, mood.da, mood.why)
  } catch (e) {
    log('[memory] 抽取失败:', (e as Error).message.slice(0, 120))
  }
}

/** 攒够一批旧对话就压成一段印象，防止 turns 无限长、也防止早期记忆被冲掉。 */
async function compactIfNeeded() {
  if (!cfg.memory) return
  const total = memory.stats().turns
  if (total < 120) return
  const batch = memory.unsedimented(80)
  if (batch.length < 60) return
  // 压缩只用「他说的」。把她的旧台词写进印象，等于把旧语气存成长期资产，
  // 以后每次调出来都在往回拽。印象应该记住的是他，不是她怎么说话。
  const mine = batch.filter((t) => t.role === 'user')
  const lines = (mine.length >= 20 ? mine : batch)
    .map((t) => `${t.role === 'user' ? '他' : '我'}：${t.text.slice(0, 160)}`)
    .join('\n')
  try {
    const out = await askRaw(
      [
        '把下面这段聊天压成 3—5 行「印象」，将来你自己看到能想起这段日子。',
        '写发生过什么、他当时的状态和在意的事，用第一人称口语，别用条目符号，别写日期。',
        '不要复述你自己当时的原话，也不要总结你的说话风格。',
        '只输出那几行字。',
      ].join('\n'),
      lines,
      320,
    )
    const text = out.replace(/^[-*\s]+/gm, '').trim()
    if (text) {
      memory.addBlock(text.slice(0, 1200), 'compact', batch[batch.length - 1].id)
      log('[memory] 压缩了', batch.length, '句 →', text.length, '字')
    }
  } catch (e) {
    log('[memory] 压缩失败:', (e as Error).message.slice(0, 120))
  }
}

/* ------------------------------------------------------------------ *
 * 看屏幕
 * ------------------------------------------------------------------ */

const SHOT_PY = path.join(__dirname, 'shot.py')
const SHOT_DIR = path.join(RUNTIME_DATA, 'shots')
/** 截图最近一次结果，给 /api/screen 和后续追问复用 */
let lastShot: { at: number; path: string; w: number; h: number; dataUrl: string } | null = null
let pyOk: string | null = null

/** 优先用 DSH 自带的 Python（一定在），再退回 PATH 里的。 */
function pyCandidates(): string[] {
  // 子进程里 LOCALAPPDATA 可能是空的，必须退回 ~/AppData/Local 拼一遍
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const cands = [
    process.env.PET_PYTHON,
    path.join(
      localAppData,
      'Programs', 'DeepSeek Harness', 'resources', 'runtime',
      'primary-runtime', 'dependencies', 'python', 'python.exe',
    ),
    'python',
    'python3',
  ].filter(Boolean) as string[]
  // 绝对路径先确认存在，省得每回都拿 ENOENT 试一次
  return cands.filter((p) => !path.isAbsolute(p) || fs.existsSync(p))
}

function runShot(py: string, out: string, width: number): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(
      py,
      [SHOT_PY, out, String(width)],
      { timeout: 10000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).slice(0, 200)))
        const line = String(stdout).trim().split('\n').pop() || '{}'
        try { resolve(JSON.parse(line)) } catch { reject(new Error('截图脚本输出解析失败')) }
      },
    )
  })
}

/** 清掉旧截图，别把磁盘塞满。 */
function pruneShots(keep = 6) {
  try {
    const files = fs.readdirSync(SHOT_DIR)
      .filter((f) => f.startsWith('shot-') && f.endsWith('.png'))
      .map((f) => ({ f, t: fs.statSync(path.join(SHOT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(keep)) fs.unlinkSync(path.join(SHOT_DIR, f))
  } catch { /* noop */ }
}

/** 抓一张当前屏幕，返回可直接塞进 messages 的 data URL。 */
async function captureScreen(width = cfg.screenWidth): Promise<string> {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const out = path.join(SHOT_DIR, `shot-${Date.now()}.png`)
  const tries = pyOk ? [pyOk] : pyCandidates()
  let lastErr: Error | null = null
  for (const py of tries) {
    const t0 = Date.now()
    try {
      const r = await runShot(py, out, width)
      if (!r?.ok) throw new Error(r?.error || '截图失败')
      pyOk = py
      const b64 = fs.readFileSync(out).toString('base64')
      lastShot = { at: Date.now(), path: out, w: r.w, h: r.h, dataUrl: 'data:image/png;base64,' + b64 }
      log('[vision] 截屏', `${r.w}x${r.h}`, `${Math.round(r.bytes / 1024)}KB`, `${Date.now() - t0}ms`, 'via', py)
      pruneShots()
      return lastShot.dataUrl
    } catch (e) {
      lastErr = e as Error
      log('[vision] 截图失败 via', py, lastErr.message)
    }
  }
  throw lastErr || new Error('没有可用的 Python')
}

/**
 * 外面递进来的图：data URL 直接用，http(s) 拉下来转 base64。
 * QQ 的图床地址多半带防盗链，所以一律由我们这边取，别指望模型自己去拿。
 */
async function toDataUrl(u: string, timeoutMs = 12000): Promise<string> {
  const s = String(u || '').trim()
  if (!s) throw new Error('图片地址为空')
  if (s.startsWith('data:')) return s
  if (!/^https?:\/\//i.test(s)) {
    // 本地路径
    const buf = fs.readFileSync(s)
    const ext = path.extname(s).slice(1).toLowerCase() || 'png'
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    return `data:${mime};base64,${buf.toString('base64')}`
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(s, { signal: ac.signal })
    if (!r.ok) throw new Error(`拉图失败 HTTP ${r.status}`)
    const mime = (r.headers.get('content-type') || 'image/png').split(';')[0]
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 8 * 1024 * 1024) throw new Error('图太大了（>8MB）')
    return `data:${mime};base64,${buf.toString('base64')}`
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 这句话是不是在问她「看屏幕」。
 * 命中就截一张；宁可多截一张，也别在她答「选什么」时抓瞎。
 */
const SCREEN_INTENT = new RegExp([
  '(看|瞧|瞅)[一下看]?(屏幕|桌面|界面|这个|这|我的电脑)',
  '这题|题目|题干|这道|选项|选(什么|哪个|啥|一下)|哪个(对|错|是|选项)',
  '帮我(看|选|读|瞅|瞧瞧)|你(看看|瞧瞧|帮我看看)',
  '我屏幕上|屏幕(上|里)|(这个|那个)(按钮|窗口|报错|界面|选项|弹窗)',
  '报错|红了|怎么(点|弄|操作)|答案是',
].join('|'), 'i')

/* ------------------------------------------------------------------ *
 * PetServer
 * ------------------------------------------------------------------ */

/** 每次请求重新扫描：装了新角色包立即生效。 */
function scan() {
  try { return figurePacks([PACKS_DIR], 'zh') } catch (e) {
    log('[packs] 扫描失败', (e as Error).message)
    return { packs: [], problems: [] } as any
  }
}

let seq = 0

function say(text: string): boolean {
  let beats: any[]
  try { beats = parseScript(text, []).beats } catch { beats = [{ text }] }
  state.mood = 'speaking'
  const ok = server.sendPet({ t: 'say', id: 's' + (++seq), beats })
  // 文字先出，声音后追。语音失败只是没声音，不影响她说的话。
  if (cfg.voiceOut) speakOut(text)
  return ok
}

function driveAct(actions: string[]): boolean {
  return server.sendPet({ t: 'act', id: 'c' + (++seq), actions })
}

function driveStatus(status: string): boolean {
  state.mood = status
  return server.sendPet({ t: 'status', status })
}

/**
 * 气泡停留时间估算。页面打字节奏：约 20 字/秒，最后一个 beat 再停 1.6s + 0.07s/字，
 * 合计约 len*0.12 + 1.6 秒。这里留足余量（**不能偏短**：偏短会让 `{t:'type'}`
 * 在回复还在打字时把气泡关掉）。
 */
function sayHold(text: string): number {
  return Math.min(26000, 2200 + [...text].length * 150)
}

let reopenTimer: NodeJS.Timeout | null = null
function reopenInput(delay: number) {
  if (!cfg.keepAsking) return
  if (reopenTimer) clearTimeout(reopenTimer)
  reopenTimer = setTimeout(() => { openTyping() }, delay)
}

/** 让鲸鱼弹出输入框（页面 openTyping → openInput）。 */
function openTyping() {
  server.sendPet({ t: 'type' })
}

/** 给鲸鱼页面发一条指令（open-settings / open-dress …）。 */
function sendOpen(t: string) {
  server.sendPet({ t } as any)
}

/**
 * 把「附属窗口」（Coopanion 宿主的装扮/设置窗口，同一个窗口）导航到某一页。
 * 宿主的 openDress() 对已存在的窗口只 show() 不导航，所以换页要靠这条广播；
 * /dress 与 /settings 两个页面都监听了它。
 */
function gotoPage(page: string) {
  server.broadcast({ t: 'goto', page } as any)
}

/* ------------------------------------------------------------------ *
 * 语音输入：本地 SenseVoice（sherpa-onnx，CPU）
 *
 * 链路：鲸鱼工具栏的麦克风 → web/mic-worklet.js（16kHz 单声道 PCM16，20ms/帧，320 样本）
 *   → WS binary → PetServer.onAudio(Int16Array) → 这里的简单能量 VAD
 *   → 一段话说完 → 本地识别 → 当作用户输入交给 handleUser。
 *
 * 模型和 DSH 自己的语音输入共用同一份（~/.dsh/speech-to-text/sensevoice/models），
 * 所以给 DSH 界面下过模型，这里就免下载。
 * ------------------------------------------------------------------ */

const ASR_ROOT = path.join(DSH_HOME, 'speech-to-text', 'sensevoice', 'models')
const ASR_MODEL = path.join(ASR_ROOT, 'sensevoice-onnx', 'model.int8.onnx')
const ASR_TOKENS = path.join(ASR_ROOT, 'sensevoice-onnx', 'tokens.txt')

let asrReason = ''

function asrReady(): boolean {
  return fs.existsSync(ASR_MODEL) && fs.existsSync(ASR_TOKENS)
}

/**
 * 识别引擎直接用 Coopanion 原版的 `SherpaAsr`（src/asr/sherpa.ts）——它自己管模型加载、
 * 释放和错误文案，比这里手搓一份稳。模型文件跟 DSH 自己的语音输入共用。
 */
const asrEngine = new SherpaAsr({
  kind: SENSEVOICE,
  model: () => (asrReady() ? { paths: { model: ASR_MODEL, tokens: ASR_TOKENS } } : { missing: '语音模型还没下载' }),
  language: () => 'auto',
  threads: () => 2,
  log: {
    info: (...a: unknown[]) => log('[asr]', ...a),
    warn: (...a: unknown[]) => log('[asr:warn]', ...a),
    error: (...a: unknown[]) => log('[asr:err]', ...a),
    debug: () => { /* 吵，不要 */ },
  } as any,
  // 自带一份在 vendor/node_modules（105KB JS 外壳 + 23MB win-x64 运行时）
  load: () => createRequire(import.meta.url)('./node_modules/sherpa-onnx-node'),
})

/** 一段话的采样缓冲；用「有声帧 + 后面跟的静音」判断说完了，不需要额外的 VAD 模型。 */
const asrSession = {
  buf: [] as Int16Array[],
  frames: 0,
  voiced: 0,
  silent: 0,
  /** 连续有声帧数，够数才算真的开口（挡掉键盘/风扇那种一下下的响） */
  onset: 0,
  active: false,
  /** 已经因为长度上限强制收尾，剩下的帧丢掉 */
  done: false,
}

const ASR_FRAME_MS = 20
const ASR_VOICE_RMS = 320
const ASR_ONSET_FRAMES = 3
const ASR_SILENCE_MS = 800
const ASR_MIN_VOICE_MS = 320
const ASR_MAX_MS = 20000

function resetAsr() {
  asrSession.buf = []
  asrSession.frames = 0
  asrSession.voiced = 0
  asrSession.silent = 0
  asrSession.onset = 0
  asrSession.active = false
  asrSession.done = false
}

function rmsOf(frame: Int16Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!
  return Math.sqrt(sum / (frame.length || 1))
}

/** 每一帧 20ms 的音频都从这里过。 */
function onAudioFrame(frame: Int16Array) {
  if (!frame.length || asrSession.done) return
  const voiced = rmsOf(frame) > ASR_VOICE_RMS

  if (!asrSession.active) {
    if (!voiced) { asrSession.onset = 0; return }
    asrSession.onset++
    if (asrSession.onset < ASR_ONSET_FRAMES) return
    // 真的开口了：把刚攒的这几帧也带上，别把字头切掉
    asrSession.active = true
    asrSession.buf = [frame]
    asrSession.frames = 1
    asrSession.voiced = 1
    asrSession.silent = 0
    log('[asr] 开始录音')
    return
  }

  asrSession.buf.push(frame)
  asrSession.frames++
  if (voiced) {
    asrSession.voiced++
    asrSession.silent = 0
  } else {
    asrSession.silent++
  }

  const elapsed = asrSession.frames * ASR_FRAME_MS
  const quiet = asrSession.silent * ASR_FRAME_MS
  const voiceMs = asrSession.voiced * ASR_FRAME_MS

  if (elapsed >= ASR_MAX_MS || (quiet >= ASR_SILENCE_MS && voiceMs >= ASR_MIN_VOICE_MS)) {
    // 静音占了这一段的绝大部分：多半是开口前的气口、键盘声。这时**不清空**，
    // 接着往下攒 —— 一旦切了，一句话就会被切成两半，前半句直接丢掉。
    if (elapsed < ASR_MAX_MS && voiceMs < elapsed * 0.35) {
      asrSession.silent = 0
      return
    }
    void finishAsr(voiceMs < ASR_MIN_VOICE_MS ? 'too-short' : 'ok')
  }
}

/** 收尾：识别 → 当用户输入。 */
async function finishAsr(why: 'ok' | 'too-short') {
  if (!asrSession.active || asrSession.done) return
  const frames = asrSession.buf
  const voiceMs = asrSession.voiced * ASR_FRAME_MS
  asrSession.done = true
  asrSession.active = false
  asrSession.buf = []

  if (why === 'too-short' || frames.length < 8) {
    log('[asr] 丢弃：太短')
    resetAsr()
    return
  }

  const total = frames.reduce((n, f) => n + f.length, 0)
  const pcm = new Int16Array(total)
  let at = 0
  for (const f of frames) { pcm.set(f, at); at += f.length }
  const seconds = (total / 16000).toFixed(1)
  log(`[asr] 录音结束 ${seconds}s，有声 ${voiceMs}ms，开始识别`)

  broadcastAsr({ phase: 'transcribing' })
  try {
    await asrEngine.start()
    const result = await asrEngine.transcribe(pcm)
    const text = String(result.text || '').trim()
    log('[asr] 识别结果:', text || `(空)${result.error ? ' ' + result.error : ''}`)
    // 只有标点、没有实际字的结果（「.」「，」）当没听清，不要当一句话发出去
    if (!text || !/[\p{L}\p{N}]/u.test(text)) {
      const why = result.error ? String(result.error).slice(0, 60) : '没听清，再说一次？'
      broadcastAsr({ phase: 'idle', hint: why })
      resetAsr()
      return
    }
    broadcastAsr({ phase: 'idle', text })
    resetAsr()
    void handleUser(text)
  } catch (e) {
    log('[asr] 识别失败:', (e as Error).message)
    broadcastAsr({ phase: 'idle', hint: '语音识别没跑起来：' + (e as Error).message.slice(0, 60) })
    resetAsr()
  }
}

/** 把语音状态推给页面，输入框里靠它显示麦克风标志。 */
function broadcastAsr(payload: Record<string, unknown>) {
  try { server.broadcast({ t: 'asr', ...payload } as any) } catch { /* 服务还没起 */ }
}

/**
 * 一句用户输入 → 模型 → 气泡回复。
 * `opts.screen` 缺省时按 SCREEN_INTENT 猜要不要看一眼屏幕。
 * `opts.images` 是外面（QQ、贴图）递进来的图，已经在手里就不用再截屏了。
 */
/** 一轮回复的完整产物：话、配图、语音。QQ 桥要用后两个。 */
type ReplyOut = { text: string; meme: string | null; audio: string | null }

async function handleUser(
  text: string,
  opts: { screen?: boolean; images?: string[]; channel?: 'desktop' | 'qq' } = {},
): Promise<ReplyOut> {
  const ch = opts.channel || 'desktop'
  // QQ 来的消息只回 QQ：不推桌面气泡、不弹表情、不放声音、不做动作，但记忆照写
  const fromQq = ch === 'qq'
  const t = String(text || '').trim().slice(0, 500)
  if (!t && !(opts.images && opts.images.length)) return { text: '', meme: null, audio: null }
  if (busy) {
    const line = '等我一下，我正在想上一句。'
    if (!fromQq) { say(line); reopenInput(sayHold(line)) }
    return { text: line, meme: null, audio: null }
  }
  busy = true
  log('[chat] 用户:', t, opts.images?.length ? `(+${opts.images.length} 张图)` : '', ch === 'qq' ? '(来自 QQ)' : '')
  // 心情层：他出现了。冷落/归来/深夜这些时间账在这里结算，
  // 赶在下面 askModel 拼 system 之前入账，这句回复就带着它。
  if (cfg.inner) innerTouch({ textLen: t.length })
  if (!cfg.apiKey) {
    const hint = '我还没拿到模型密钥。右键点我，按那个齿轮就能填。'
    if (!fromQq) say(hint)
    log('[chat] 没有 apiKey，已提示去设置')
    busy = false
    return { text: hint, meme: null, audio: null }
  }
  if (!fromQq) {
    driveStatus('thinking')
    driveAct(['heard'])
  }
  try {
    const images: string[] = [...(opts.images || [])]
    // 外面递进来的图当成「别人发的」，别说成屏幕截图，否则她会答非所问
    let hint: 'screen' | 'posted' = images.length ? 'posted' : 'screen'
    // 手里没有图，才考虑自己看一眼屏幕
    if (!images.length && cfg.vision && (opts.screen ?? SCREEN_INTENT.test(t))) {
      try {
        images.push(await captureScreen())
        hint = 'screen'
      } catch (e) {
        log('[vision] 这一轮没看到屏幕:', (e as Error).message)
      }
    }
    // 记忆：这一轮她该想起来的事（长期事实 + 相关旧对话）
    const mem = cfg.memory ? memory.brief(t || '图片') : ''
    const t0 = Date.now()
    const reply = await askModel(t || '（发来一张图，没说话）', { images, hint, memory: mem, channel: ch })
    log('[chat] 回复耗时', `${Date.now() - t0}ms`, images.length ? '(带截图)' : '(纯文字)', mem ? '(带记忆)' : '')
    history.push({ role: 'user', content: t }, { role: 'assistant', content: reply })
    if (history.length > HISTORY_MAX * 2) history.splice(0, history.length - HISTORY_MAX * 2)
    // 落库：桌面和 QQ 共用同一个库，跨端可见
    if (cfg.memory) {
      memory.remember({ channel: ch, role: 'user', text: t || '（发来一张图片）', imgs: images.length })
      memory.remember({ channel: ch, role: 'assistant', text: reply })
      scheduleLearn(t, reply, ch)
      maybeReflect(ch)
    }
    log('[chat] Coo:', reply.slice(0, 120))
    // 回复里带 [表情:tag] 就把图单独发出来，话里不留这个标记；
    // 她这一轮忘了发，就按话里的情绪补一张（下限由轮次计数兜）
    let { text: spoken, meme } = splitMeme(reply)
    if (!meme) meme = autoMeme(spoken)
    const line = spoken || (meme ? '（递过来一张图）' : reply)
    if (fromQq) {
      // QQ 通道：桌面一个字都不显示、不出声，表情跟着 QQ 那条消息发就行
      if (meme) { sinceLastMeme = 0; log('[meme] 只发 QQ:', meme.tag) } else sinceLastMeme++
    } else {
      say(line)
      if (meme) { pushMeme(meme); sinceLastMeme = 0; log('[meme] 发了:', meme.tag, meme.file) }
      else sinceLastMeme++
    }
    // 语音：桌面走 say() 异步推给页面；QQ 通道在这里单独合成，不经过页面
    let audio: string | null = null
    if (cfg.voiceOut) {
      audio = await Promise.race([
        tts(line),
        new Promise<null>((r) => setTimeout(() => r(null), 8000)),
      ]).catch(() => null)
    }
    if (!fromQq) {
      driveStatus('idle')
      reopenInput(sayHold(line))
    }
    return { text: line, meme: meme ? memeUrl(meme) : null, audio }
  } catch (e) {
    const msg = (e as Error).message || '出错了'
    const line = `唔……我这边出问题了：${msg.slice(0, 120)}`
    if (!fromQq) {
      say(line)
      driveStatus('idle')
      reopenInput(sayHold(line))
    }
    log('[chat] 失败:', msg)
    reopenInput(sayHold(line))
    return { text: line, meme: null, audio: null }
  } finally {
    busy = false
    // 攒够一批就把早前的对话压成印象，别让记忆一直长
    if (cfg.memory && memory.stats().turns % 40 === 0) void compactIfNeeded()
  }
}

/** 桌面页面（浮窗/浏览器）是否连着：主动开口前要看一眼，气泡没人看就别白说。 */
let petPageConnected = false

const server: PetServer = new PetServer({
  port: () => PET_PORT,
  webDir: WEB_DIR,
  onPetConnect: () => { petPageConnected = true },
  onPetDisconnect: () => { petPageConnected = false },
  snapshot: () => ({
    ...state,
    // 语音状态：少了它页面 prefs.voice.ready 永远是 false，按钮一直转圈、按住说话也不生效
    voice: voiceState(),
    // 「上线 QQ」那一格：online 点亮，busy 表示正在拉 QQ
    qq: qqState(),
    // 菜单头部的运行控制（⏸ / ⚙ / ⏻）只在 `bot.controls` 为真时才渲染 —— 原版 Coopanion
    // 由宿主 app 提供这块，桥接版必须自己给，否则右键菜单里根本没有「设置」按钮。
    bot: {
      name: cfg.name,
      controls: true,
      paused: false,
      buttons: { pause: false, settings: true, quit: true },
      quitLabel: '收起桌宠',
      quitPrompt: '要让小鲸鱼先躲到一边吗？',
    },
  }),
  packs: () => scan().packs,
  packProblems: () => scan().problems,
  onPetMessage: (msg) => {
    const t = msg.t
    if (t === 'text') { void handleUser(String(msg.text ?? '')); return }
    if (t === 'answer') { void handleUser(String(msg.text ?? '')); return }
    if (t === 'control') {
      const a = String(msg.action ?? '')
      if (a === 'settings') { gotoPage('/settings'); sendOpen('open-settings'); return }
      if (a === 'dress') { gotoPage('/dress'); return }
      // 菜单里那格「上线 QQ」是个开关：没上线就拉起，在线了就下线
      if (a === 'qq') { void qqGoOnline('page'); return }
      if (a === 'qq-off') { void qqGoOffline('page'); return }
      if (a === 'pause') { state.quiet = true; return }
      if (a === 'resume') { state.quiet = false; return }
      if (a === 'quit') {
        log('[pet] 页面请求收起浮窗')
        try { petProc?.kill() } catch { /* noop */ }
        petProc = null
        return
      }
      return
    }
    // 麦克风的真实开关状态由页面自己报（拿到了设备 / 被拒绝 / 出错）
    if (t === 'mic') {
      const st = String((msg as any).state || '')
      log('[mic]', st, (msg as any).detail || '')
      if (st !== 'on') resetAsr()
      // 转给所有页面：输入框靠它显示麦克风标志
      try { server.broadcast({ t: 'mic', state: st, detail: (msg as any).detail ?? null } as any) } catch { /* noop */ }
      return
    }
    if (t === 'prefs') {
      // 这里必须真的走一遍偏好处理：页面点了麦克风，只有收到广播回来的 mic:true 才会开麦
      applyPrefs(msg as Record<string, unknown>)
      return
    }
    if (t === 'expand' || t === 'hello' || t === 'figure') return
    log('[pet] page→host:', t)
  },
  // 鲸鱼工具栏麦克风的音频（16kHz 单声道 PCM16，20ms 一帧）
  onAudio: (frame) => { onAudioFrame(frame) },
  onPetConnect: () => {
    log('[pet-service] 桌宠窗口已连接')
    greet()
  },
  onPetDisconnect: () => log('[pet-service] 桌宠窗口已断开'),
  /**
   * 装扮页保存了新皮肤。原版 World 的做法是 `persist({skin})` + 广播 `prefs`，
   * 少了广播这一步，已经在桌面上的鲸鱼不会当场换装；少了落盘，重启后又回到默认。
   */
  onSkin: (skin) => {
    if (!skin || typeof skin !== 'object') return
    state.skin = { ...DEFAULT_SKIN, ...(skin as Record<string, unknown>) }
    saveSkin(state.skin)
    server.broadcast({ t: 'prefs', ...state } as any)
    log('[skin] 已更换:', JSON.stringify(state.skin).slice(0, 200))
  },
  onPrefs: (prefs) => applyPrefs(prefs as Record<string, unknown>),
  language: () => 'zh',
  /** 设置页与聊天 API（与 /pet 同源，页面可直接 fetch） */
  extra: async (p, req, res) => {
    const method = req.method || 'GET'
    // 表情包图片：只放行图库目录内的文件，别让人拿 .. 读别处
    if (method === 'GET' && p.startsWith('/meme/')) {
      const root = path.join(memePackDir(), 'memes')
      let full: string
      try {
        full = path.resolve(root, decodeURIComponent(p.slice('/meme/'.length)))
      } catch {
        res.writeHead(400).end(); return true
      }
      if (!full.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(full)) {
        res.writeHead(404).end(); return true
      }
      const ext = path.extname(full).toLowerCase()
      const mime = ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
        : 'image/jpeg'
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'max-age=3600' })
      res.end(fs.readFileSync(full))
      return true
    }
    if (p === '/api/memes' && method === 'GET') {
      json(res, 200, { pack: memePackDir(), count: memeLib.length, memes: memeLib })
      return true
    }
    /* ---- 语音（TTS）---- */
    if (method === 'GET' && p.startsWith('/voice/')) {
      const name = path.basename(decodeURIComponent(p.slice('/voice/'.length)))
      if (!/^[a-f0-9]{16}\.(mp3|wav|m4a|ogg)$/i.test(name)) { res.writeHead(400).end(); return true }
      const full = path.join(VOICE_DIR, name)
      if (!fs.existsSync(full)) { res.writeHead(404).end(); return true }
      const ext = path.extname(name).toLowerCase()
      const mime = ext === '.wav' ? 'audio/wav'
        : ext === '.m4a' ? 'audio/mp4'
        : ext === '.ogg' ? 'audio/ogg'
        : 'audio/mpeg'
      const st = fs.statSync(full)
      res.writeHead(200, {
        'content-type': mime,
        'content-length': st.size,
        'cache-control': 'max-age=86400',
      })
      res.end(fs.readFileSync(full))
      return true
    }
    if (p === '/api/tts' && method === 'POST') {
      const body = await readBody(req)
      let text = ''
      try { text = String(JSON.parse(body || '{}').text || '') } catch { /* noop */ }
      const t0 = Date.now()
      const url = await tts(text)
      json(res, url ? 200 : 500, {
        ok: !!url,
        url,
        ms: Date.now() - t0,
        file: url ? path.join(VOICE_DIR, path.basename(url)) : null,
      })
      return true
    }
    /* ---- 记忆 ---- */
    /** 内心状态快照：mood/baseline/最近事件/注入预览。调试和设置页面板都吃这个。 */
    if (p === '/api/inner' && method === 'GET') {
      json(res, 200, cfg.inner
        ? { ok: true, ...innerSnapshot(), pro: innerProCounters() }
        : { ok: true, disabled: true })
      return true
    }
    if (p === '/api/memory' && method === 'GET') {
      json(res, 200, {
        ok: true,
        ...memory.stats(),
        facts: memory.facts.slice(0, 80),
        blocks: memory.blocks(3),
        recent: memory.recent(10).map((t) => ({
          ts: t.ts, when: new Date(t.ts).toLocaleString('zh-CN'), channel: t.channel,
          role: t.role, text: t.text.slice(0, 300),
        })),
      })
      return true
    }
    if (p === '/api/memory/note' && method === 'POST') {
      const body = await readBody(req)
      let key = ''
      let value = ''
      try {
        const j = JSON.parse(body || '{}')
        key = String(j.key || '')
        value = String(j.value || j.text || '')
      } catch { /* noop */ }
      if (!value.trim()) { json(res, 400, { ok: false, error: 'value 为空' }); return true }
      memory.setFact(key.trim() || `主人说的（${new Date().toLocaleDateString('zh-CN')}）`, value, 'manual')
      json(res, 200, { ok: true, facts: memory.facts.length })
      return true
    }
    if (p === '/api/memory/forget' && method === 'POST') {
      const body = await readBody(req)
      let id = 0
      try { id = Number(JSON.parse(body || '{}').id || 0) } catch { /* noop */ }
      const ok = id > 0 ? memory.forgetFact(id) : false
      json(res, 200, { ok, facts: memory.facts.length })
      return true
    }
    if (p === '/api/memory/search' && method === 'GET') {
      const q = new URL(req.url || '/', 'http://x').searchParams.get('q') || ''
      json(res, 200, {
        ok: true, q,
        hits: memory.recall(q, 12).map((t) => ({
          when: new Date(t.ts).toLocaleString('zh-CN'), channel: t.channel, role: t.role,
          text: t.text.slice(0, 300),
        })),
      })
      return true
    }
    if (p === '/api/memory/compact' && method === 'POST') {
      void compactIfNeeded()
      json(res, 200, { ok: true, queued: true })
      return true
    }
    if (p === '/api/config' && method === 'GET') {
      json(res, 200, { ...cfg, hasKey: !!cfg.apiKey })
      return true
    }
    if (p === '/api/config' && method === 'POST') {
      const body = await readBody(req)
      try {
        const patch = JSON.parse(body || '{}') as Record<string, unknown>
        delete patch.hasKey
        writeCfg(patch as Partial<Config>)
        json(res, 200, { ok: true, ...cfg, hasKey: !!cfg.apiKey })
      } catch {
        json(res, 400, { ok: false, error: 'bad json' })
      }
      return true
    }
    if (p === '/api/chat/test' && method === 'POST') {
      try {
        const started = Date.now()
        const reply = await askModel('用一句话打个招呼，证明你在线。')
        json(res, 200, { ok: true, ms: Date.now() - started, reply })
      } catch (e) {
        json(res, 200, { ok: false, error: (e as Error).message })
      }
      return true
    }
    if (p === '/api/chat/reset' && method === 'POST') {
      history.length = 0
      json(res, 200, { ok: true })
      return true
    }
    /* ---- 看屏幕 ---- */
    if (p === '/api/screen' && method === 'POST') {
      const t0 = Date.now()
      try {
        const dataUrl = await captureScreen()
        const b64 = dataUrl.split(',')[1] || ''
        json(res, 200, {
          ok: true,
          ms: Date.now() - t0,
          w: lastShot?.w, h: lastShot?.h,
          bytes: Math.round(b64.length * 0.75),
          path: lastShot?.path,
        })
      } catch (e) {
        json(res, 200, { ok: false, error: (e as Error).message })
      }
      return true
    }
    /** 测试入口 / QQ 桥入口：替页面说一句话，可带图，返回回复原文 + 配图 + 语音 */
    if (p === '/api/chat/say' && method === 'POST') {
      const body = await readBody(req)
      let text = ''
      let screen: boolean | undefined
      let rawImages: string[] = []
      let channel: 'desktop' | 'qq' = 'desktop'
      try {
        const j = JSON.parse(body || '{}')
        text = String(j.text || '')
        if (typeof j.screen === 'boolean') screen = j.screen
        if (j.channel === 'qq') channel = 'qq'
        if (Array.isArray(j.images)) rawImages = j.images.filter((x: unknown) => typeof x === 'string')
        else if (typeof j.image === 'string') rawImages = [j.image]
      } catch { /* noop */ }
      if (!text.trim() && !rawImages.length) {
        json(res, 400, { ok: false, error: 'text 为空' }); return true
      }
      const images: string[] = []
      for (const u of rawImages.slice(0, 4)) {
        try { images.push(await toDataUrl(u)) } catch (e) {
          log('[vision] 外部图取不到:', (e as Error).message)
        }
      }
      const t0 = Date.now()
      const out = await handleUser(text, { screen, images, channel })
      json(res, 200, {
        ok: true,
        ms: Date.now() - t0,
        reply: out.text,
        images: images.length,
        meme: out.meme,
        audio: out.audio,
      })
      return true
    }
    if (p === '/api/window/open' && method === 'POST') {
      const r = openPetWindow(true)
      json(res, 200, r)
      return true
    }
    if (p === '/api/window/status' && method === 'GET') {
      json(res, 200, { running: !!petProc, exe: cfg.petHostExe, exists: fs.existsSync(cfg.petHostExe) })
      return true
    }
    if (p === '/api/packs/install' && method === 'POST') {
      const body = await readBody(req)
      let url = ''
      try { url = String(JSON.parse(body || '{}').url || '') } catch { /* noop */ }
      const out = await installPackFromUrl(url)
      json(res, out.ok ? 200 : 400, out)
      return true
    }
    /* ---- 技能（Skills）---- */
    if (p === '/api/skills' && method === 'GET') {
      json(res, 200, { ok: true, ...scanSkills() })
      return true
    }
    if (p === '/api/skills/install' && method === 'POST') {
      const body = await readBody(req)
      let url = ''
      try { url = String(JSON.parse(body || '{}').url || '') } catch { /* noop */ }
      const out = await installSkillsFromUrl(url)
      json(res, out.ok ? 200 : 400, { ...out, ...scanSkills() })
      return true
    }
    if (p === '/api/skills/remove' && method === 'POST') {
      const body = await readBody(req)
      let name = ''
      try { name = String(JSON.parse(body || '{}').name || '') } catch { /* noop */ }
      const out = removeSkill(name)
      json(res, out.ok ? 200 : 400, { ...out, ...scanSkills() })
      return true
    }
    if (p === '/api/skills/reveal' && method === 'POST') {
      revealDir(SKILLS_DIR)
      json(res, 200, { ok: true, dir: SKILLS_DIR })
      return true
    }
    return false
  },
})

/* ------------------------------------------------------------------ *
 * 开场白
 * ------------------------------------------------------------------ */

let greeted = false
function greet() {
  if (greeted) return
  greeted = true
  const line = cfg.apiKey ? cfg.greeting : '我在这儿。右键点我 → 齿轮，填一下模型密钥就能聊天了。'
  say(line)
  reopenInput(sayHold(line))
}

/* ------------------------------------------------------------------ *
 * 桌面浮窗：借 Coopanion.exe 的 --pet-host 模式
 * ------------------------------------------------------------------ */

let petProc: ReturnType<typeof spawn> | null = null

function openPetWindow(force = false): { ok: boolean; mode: 'window' | 'browser' | 'skipped'; reason?: string } {
  if (process.env.PET_NO_WINDOW === '1') return { ok: false, mode: 'skipped', reason: 'PET_NO_WINDOW=1（测试模式）' }
  if (!force && !cfg.autoOpenWindow) return { ok: false, mode: 'skipped', reason: 'autoOpenWindow 关闭' }
  const exe = cfg.petHostExe
  if (!exe || !fs.existsSync(exe)) {
    log('[window] 没找到 Coopanion.exe：', exe)
    return { ok: false, mode: 'browser', reason: `找不到 ${exe}` }
  }
  if (petProc && !petProc.killed) {
    try { petProc.kill() } catch { /* noop */ }
    petProc = null
  }
  try { fs.mkdirSync(RUNTIME_DATA, { recursive: true }) } catch { /* noop */ }

  const url = server.windowUrl
  log('[window] 拉起透明浮窗：', exe, url)
  // 关键：宿主环境（DSH / 打包后的 Electron）常带着 ELECTRON_RUN_AS_NODE=1，
  // 它会让 Coopanion.exe 以「纯 Node」身份运行，把 --pet-host 当成非法参数直接退出。
  // 必须剔除，才能真的开 Electron 窗口。
  const env: NodeJS.ProcessEnv = { ...process.env, CORTICO_COMPANION_DATA: RUNTIME_DATA }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  petProc = spawn(exe, ['--pet-host', `--pet-url=${url}`, `--parent-pid=${process.pid}`], {
    // 独立的数据目录：不污染 Coopanion 自己的 data/
    env,
    stdio: 'ignore',
    detached: false,
  })
  petProc.on('error', (e) => log('[window] 启动失败:', (e as Error).message))
  petProc.on('exit', (code) => { log('[window] 浮窗进程退出 code=', code); petProc = null })
  return { ok: true, mode: 'window' }
}

/* ------------------------------------------------------------------ *
 * GitHub 角色包安装（"从 GitHub 接插件"）
 * ------------------------------------------------------------------ */

function githubZipCandidates(input: string): string[] {
  const s = input.trim()
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(s)
  if (m) {
    const owner = m[1]
    const repo = m[2].replace(/\.git$/i, '')
    const branchHit = /\/tree\/([^/\s#?]+)/i.exec(s)
    const branches = branchHit ? [branchHit[1]] : ['main', 'master']
    return branches.map((b) => `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${b}`)
  }
  if (/^https?:\/\/\S+\.zip$/i.test(s)) return [s]
  return []
}

/** 下载 zip、解出含 figure.json 的目录，装进 packs/。 */
async function installPackFromUrl(input: string): Promise<{ ok: boolean; id?: string; error?: string; installed?: string[] }> {
  const urls = githubZipCandidates(input)
  if (!urls.length) return { ok: false, error: '请填 GitHub 仓库地址或 zip 直链' }
  let buf: Uint8Array | null = null
  let lastErr = ''
  for (const u of urls) {
    try {
      log('[packs] 下载', u)
      const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(60000) })
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue }
      buf = new Uint8Array(await res.arrayBuffer())
      break
    } catch (e) {
      lastErr = (e as Error).message
    }
  }
  if (!buf) return { ok: false, error: `下载失败：${lastErr}` }

  let files: Record<string, Uint8Array>
  try { files = unzipSync(buf) } catch (e) {
    return { ok: false, error: `解压失败：${(e as Error).message}` }
  }
  // 去掉 zip 里统一的顶层目录
  const names = Object.keys(files)
  const firstSeg = names[0]?.split('/')[0] ?? ''
  const strip = names.every((n) => n.startsWith(firstSeg + '/')) ? firstSeg.length + 1 : 0
  const flat: Record<string, Uint8Array> = {}
  for (const [n, v] of Object.entries(files)) {
    if (n.endsWith('/')) continue
    flat[n.slice(strip)] = v
  }
  // 找 figure.json 所在目录（支持仓库里再套一层）
  const manifestKey = Object.keys(flat).find((n) => n === 'figure.json' || n.endsWith('/figure.json'))
  if (!manifestKey) return { ok: false, error: '这个仓库里没有 figure.json，不是角色包' }
  const prefix = manifestKey.slice(0, manifestKey.length - 'figure.json'.length)

  let id = ''
  try { id = String(JSON.parse(strFromU8(flat[manifestKey]!)).id || '') } catch { /* noop */ }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return { ok: false, error: 'figure.json 里的 id 不合法' }
  if (id === 'coo') return { ok: false, error: '不能覆盖内置的 coo' }

  const dest = path.join(PACKS_DIR, id)
  try {
    fs.rmSync(dest, { recursive: true, force: true })
    for (const [n, v] of Object.entries(flat)) {
      if (!n.startsWith(prefix)) continue
      const rel = n.slice(prefix.length)
      if (!rel) continue
      const full = path.join(dest, rel)
      if (!path.resolve(full).startsWith(path.resolve(dest) + path.sep)) continue
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, v)
    }
  } catch (e) {
    return { ok: false, error: `写入失败：${(e as Error).message}` }
  }
  const after = scan()
  const ok = after.packs.some((p: any) => p.id === id)
  const why = after.problems.find((p: any) => path.basename(p.dir) === id)
  log('[packs] 安装', id, ok ? '成功' : `失败 ${why?.reason ?? ''}`)
  if (!ok) return { ok: false, error: why?.reason || '装完了但校验没通过' }
  return { ok: true, id, installed: after.packs.map((p: any) => p.id) }
}

/* ------------------------------------------------------------------ *
 * 技能（Skills）：从 GitHub 装到 $DSH_HOME/skills
 *
 * DSH 的技能 = 一个目录 + SKILL.md（YAML frontmatter 里必须有 name/description）。
 * 内置的 dsh-skill-filesystem 会扫 $DSH_HOME/skills，frontmatter 合法就注册进
 * 技能目录、暴露成 skill 工具给模型。所以「装技能」= 把目录放进那个位置。
 * 一个 GitHub 仓库里可以有很多个技能（如 anthropics/skills 的 skills/*），
 * 全都装。
 * ------------------------------------------------------------------ */

export type SkillItem = {
  name: string
  description: string
  whenToUse?: string
  dir: string
  files: number
  /** 是否带可执行脚本（scripts/ 或 .py/.js/.sh），装的时候要提醒 */
  hasScripts: boolean
}

/** 只解析 frontmatter 需要的这一层，不引 yaml 依赖。 */
function parseFrontmatter(raw: string): Record<string, string> | null {
  const text = raw.replace(/^\uFEFF/, '')
  if (!/^---\s*(\r?\n)/.test(text)) return null
  const body = text.replace(/^---\s*\r?\n/, '')
  const close = body.search(/\r?\n---\s*(\r?\n|$)/)
  if (close < 0) return null
  const head = body.slice(0, close)
  const out: Record<string, string> = {}
  let key = ''
  let lines: string[] = []
  let folded = false
  const flush = () => {
    if (!key) return
    out[key] = (folded ? lines.join(' ') : lines.join('\n')).trim()
    key = ''
    lines = []
    folded = false
  }
  for (const line of head.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (m) {
      flush()
      key = m[1]!
      const v = m[2]!.trim()
      if (/^[|>][-+]?$/.test(v)) { folded = v.startsWith('>'); lines = [] }
      else lines = [v]
      continue
    }
    if (key) lines.push(line.trim())
  }
  flush()
  for (const k of Object.keys(out)) {
    const v = out[k]!
    out[k] = /^['"].*['"]$/.test(v) ? v.slice(1, -1) : v
  }
  return out
}

function countFiles(dir: string): number {
  let n = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += countFiles(path.join(dir, e.name))
      else n++
    }
  } catch { /* noop */ }
  return n
}

function scanSkills(): { dir: string; items: SkillItem[]; problems: { dir: string; reason: string }[] } {
  const items: SkillItem[] = []
  const problems: { dir: string; reason: string }[] = []
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }) } catch {
    return { dir: SKILLS_DIR, items, problems }
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || !e.isDirectory()) continue
    const dir = path.join(SKILLS_DIR, e.name)
    let raw = ''
    try { raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') } catch {
      problems.push({ dir, reason: '没有 SKILL.md' })
      continue
    }
    const fm = parseFrontmatter(raw)
    if (!fm?.name || !fm?.description) {
      problems.push({ dir, reason: 'SKILL.md 的 frontmatter 缺 name 或 description' })
      continue
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name)) {
      problems.push({ dir, reason: `技能名 "${fm.name}" 不合法（只能小写字母/数字/连字符）` })
      continue
    }
    const sub = (n: string) => { try { return fs.existsSync(path.join(dir, n)) } catch { return false } }
    items.push({
      name: fm.name,
      description: fm.description,
      whenToUse: fm.whenToUse,
      dir,
      files: countFiles(dir),
      hasScripts: sub('scripts') || sub('bin'),
    })
  }
  return { dir: SKILLS_DIR, items, problems }
}

/** 下载 zip 并解出所有 SKILL.md 目录，逐个装进 $DSH_HOME/skills/<name>。 */
async function installSkillsFromUrl(input: string): Promise<{
  ok: boolean
  installed?: string[]
  updated?: string[]
  error?: string
}> {
  const urls = githubZipCandidates(input)
  if (!urls.length) return { ok: false, error: '请填 GitHub 仓库地址或 zip 直链' }

  let buf: Uint8Array | null = null
  let lastErr = ''
  for (const u of urls) {
    try {
      log('[skills] 下载', u)
      const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue }
      buf = new Uint8Array(await res.arrayBuffer())
      break
    } catch (e) { lastErr = (e as Error).message }
  }
  if (!buf) return { ok: false, error: `下载失败：${lastErr}` }

  let files: Record<string, Uint8Array>
  try { files = unzipSync(buf) } catch (e) {
    return { ok: false, error: `解压失败：${(e as Error).message}` }
  }
  const names = Object.keys(files).filter((n) => !n.endsWith('/'))
  if (!names.length) return { ok: false, error: 'zip 里没有文件' }
  // 去掉 zip 统一的顶层目录（GitHub 打包会套一层 repo-branch/）
  const firstSeg = names[0]!.split('/')[0] ?? ''
  const strip = firstSeg && names.every((n) => n.startsWith(firstSeg + '/')) ? firstSeg.length + 1 : 0
  const flat: Record<string, Uint8Array> = {}
  for (const n of names) flat[n.slice(strip)] = files[n]!

  // 每个 SKILL.md 是一个技能；Windows 路径分隔统一成 /
  const manifests = Object.keys(flat).filter((n) => n === 'SKILL.md' || n.endsWith('/SKILL.md'))
  if (!manifests.length) {
    return {
      ok: false,
      error: '这个仓库里没有 SKILL.md，不是 DSH 技能包（技能包必须有 SKILL.md + frontmatter 的 name/description）',
    }
  }

  const installed: string[] = []
  const updated: string[] = []
  const failed: string[] = []
  for (const manifest of manifests) {
    const prefix = manifest.slice(0, manifest.length - 'SKILL.md'.length)
    let fm: Record<string, string> | null = null
    try { fm = parseFrontmatter(strFromU8(flat[manifest]!)) } catch { /* noop */ }
    if (!fm?.name || !fm?.description) { failed.push(prefix || '(仓库根)'); continue }
    const name = fm.name
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) { failed.push(`${name}（名字不合法）`); continue }

    const dest = path.join(SKILLS_DIR, name)
    const existed = fs.existsSync(dest)
    // 先写到临时目录再换过去，避免装一半留下坏技能；无论成败都不留 tmp
    const tmp = path.join(SKILLS_DIR, `.tmp-${name}-${Date.now()}`)
    try {
      fs.mkdirSync(tmp, { recursive: true })
      for (const [n, v] of Object.entries(flat)) {
        if (!n.startsWith(prefix)) continue
        const rel = n.slice(prefix.length)
        if (!rel) continue
        const full = path.join(tmp, rel)
        if (!path.resolve(full).startsWith(path.resolve(tmp) + path.sep)) continue
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, Buffer.from(v))
      }
      fs.rmSync(dest, { recursive: true, force: true })
      try {
        fs.renameSync(tmp, dest)
      } catch {
        // Windows 上目标目录被占用（杀软 / 资源管理器开着）时 rename 会失败，
        // 退回逐文件拷贝，慢一点但能装上
        fs.cpSync(tmp, dest, { recursive: true, force: true })
      }
      ;(existed ? updated : installed).push(name)
    } catch (e) {
      failed.push(`${name}（写入失败：${(e as Error).message}）`)
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
    }
  }

  log('[skills] 安装结果 installed=', installed.join(','), 'updated=', updated.join(','), 'failed=', failed.join(','))
  if (!installed.length && !updated.length) {
    return { ok: false, error: `没能装成任何技能：${failed.join('；') || '未知原因'}` }
  }
  return { ok: true, installed, updated }
}

/** 卸载 = 挪到 skills-disabled/，随时能捡回来。 */
function removeSkill(name: string): { ok: boolean; movedTo?: string; error?: string } {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return { ok: false, error: '技能名不合法' }
  const dir = path.join(SKILLS_DIR, name)
  if (!fs.existsSync(dir)) return { ok: false, error: '没找到这个技能' }
  try {
    fs.mkdirSync(SKILLS_TRASH, { recursive: true })
    const to = path.join(SKILLS_TRASH, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    fs.renameSync(dir, to)
    log('[skills] 已卸载', name, '->', to)
    return { ok: true, movedTo: to }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 在资源管理器里打开目录（Windows）。 */
function revealDir(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
  try {
    if (process.platform === 'win32') execFile('explorer.exe', [dir])
    else if (process.platform === 'darwin') execFile('open', [dir])
    else execFile('xdg-open', [dir])
  } catch (e) { log('[reveal] 失败', (e as Error).message) }
}

/* ------------------------------------------------------------------ *
 * 本地控制端口（DSH 插件转发会话事件 + 手动控制台）
 * ------------------------------------------------------------------ */

const ctrl = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url || '/'
  if (req.method === 'GET') {
    if (url === '/' || url === '/console') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CONSOLE_HTML())
      return
    }
    if (url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ ...state, petPort: PET_PORT, ctrlPort: CTRL_PORT, hasKey: !!cfg.apiKey, window: !!petProc, qq: qqState() }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
    return
  }
  if (req.method === 'POST' && url === '/control') {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      try {
        const m = JSON.parse(body)
        let ok = false
        if (m.action === 'say' && typeof m.text === 'string') ok = say(m.text)
        // 上线 QQ：和菜单里那一格走同一条路（验证脚本也走这里）
        else if (m.action === 'qq') { void qqGoOnline('ctrl'); ok = true }
        else if (m.action === 'qq-off') { void qqGoOffline('ctrl'); ok = true }
        else if (m.action === 'act' && Array.isArray(m.actions)) ok = driveAct(m.actions as string[])
        else if (m.action === 'thinking') ok = driveStatus('thinking')
        else if (m.action === 'listening') ok = driveStatus('listening')
        else if (m.action === 'idle') ok = driveStatus('idle')
        else if (m.action === 'wake') ok = driveStatus('wake')
        else if (m.action === 'sleep') ok = driveStatus('sleep')
        // 手动改语音状态广播（测试 / 从控制台模拟麦克风开合）
        else if (m.action === 'voice') {
          const on = m.on !== false
          server.broadcast({ t: 'mic', state: on ? 'on' : 'off', detail: null } as any)
          if (!on) resetAsr()
          ok = true
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok }))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'bad json' }))
      }
    })
    return
  }
  res.writeHead(404).end()
})

const CONSOLE_HTML = () => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>鲸鱼控制台 · Coo Console</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --bd:#e3e6ea; --tx:#1f2329; --mut:#8a9099; --acc:#2f7dcd; --acc2:#36b37e; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,'PingFang SC','Microsoft YaHei',sans-serif; background:var(--bg); color:var(--tx); padding:18px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--mut); margin:0 0 16px; font-size:12px; }
  .card { background:var(--card); border:1px solid var(--bd); border-radius:12px; padding:14px 16px; margin-bottom:14px; }
  .card h2 { font-size:13px; margin:0 0 10px; color:var(--mut); letter-spacing:.04em; text-transform:uppercase; }
  textarea { width:100%; border:1px solid var(--bd); border-radius:8px; padding:8px 10px; font:inherit; resize:vertical; }
  .row { display:flex; flex-wrap:wrap; gap:8px; }
  button { cursor:pointer; border:1px solid var(--bd); background:#fff; color:var(--tx); border-radius:8px; padding:7px 12px; font:inherit; transition:.12s; }
  button:hover { border-color:var(--acc); color:var(--acc); }
  button.primary { background:var(--acc); border-color:var(--acc); color:#fff; }
  button.green { background:var(--acc2); border-color:var(--acc2); color:#fff; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(92px,1fr)); gap:8px; }
  .state { font-size:13px; }
  .state b { color:var(--acc); }
  #log { font:12px/1.6 ui-monospace,Menlo,Consolas,monospace; color:var(--mut); max-height:150px; overflow:auto; margin-top:8px; }
  #log div { padding:1px 0; border-bottom:1px solid #f0f1f3; }
  a.btn { display:inline-block; text-decoration:none; }
</style>
</head>
<body>
  <h1>鲸鱼控制台 · Coo Console</h1>
  <p class="sub">DSH 会话事件会自动驱动桌宠；这里可以手动让它说话、做动作。聊天请直接双击桌面上的鲸鱼。</p>

  <div class="card">
    <h2>说话</h2>
    <textarea id="sayText" rows="2" placeholder="输入要让鲸鱼说的话..."></textarea>
    <div class="row" style="margin-top:8px;">
      <button class="primary" onclick="sendSay()">让鲸鱼说话</button>
      <button onclick="post({action:'idle'})">回到待机</button>
    </div>
  </div>

  <div class="card">
    <h2>表情 / 动作</h2>
    <div class="grid" id="acts"></div>
  </div>

  <div class="card">
    <h2>设置与外观</h2>
    <div class="row">
      <a class="btn" href="http://127.0.0.1:${PET_PORT}/settings" target="_blank"><button class="primary">设置 · 密钥 / 人设 / 技能</button></a>
      <a class="btn" href="http://127.0.0.1:${PET_PORT}/dress" target="_blank"><button class="green">换皮肤 / 装扮</button></a>
      <a class="btn" href="http://127.0.0.1:${PET_PORT}/pet" target="_blank"><button>网页版鲸鱼</button></a>
    </div>
  </div>

  <div class="card">
    <h2>当前状态</h2>
    <div class="state">情绪：<b id="mood">—</b>　·　密钥：<b id="key">—</b>　·　浮窗：<b id="win">—</b></div>
    <div id="log"></div>
  </div>

<script>
  var ACTS = ['wave','cheer','bounce','nod','shake','spin','bow','dance','sit','look','perk','heard'];
  var LABELS = {wave:'挥手',cheer:'欢呼',bounce:'蹦跳',nod:'点头',shake:'摇头',spin:'转圈',bow:'鞠躬',dance:'跳舞',sit:'坐下',look:'张望',perk:'好奇',heard:'听到'};
  var box = document.getElementById('acts');
  ACTS.forEach(function(a){
    var b = document.createElement('button');
    b.textContent = LABELS[a] || a;
    b.onclick = function(){ post({action:'act',actions:[a]}).then(function(j){ log('act['+a+']: '+(j.ok?'OK':'FAIL')); }); };
    box.appendChild(b);
  });
  var logEl = document.getElementById('log');
  function log(msg){ var d=document.createElement('div'); d.textContent=msg; logEl.insertBefore(d, logEl.firstChild); }
  function post(obj){ return fetch('/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(obj)}).then(function(r){return r.json();}); }
  function sendSay(){ var t=document.getElementById('sayText').value.trim(); if(!t) return; post({action:'say',text:t}).then(function(j){ log('say: '+(j.ok?'OK':'FAIL')+'  '+t.slice(0,40)); }); }
  function refresh(){ fetch('/state').then(function(r){return r.json();}).then(function(s){
    document.getElementById('mood').textContent = s.mood||'—';
    document.getElementById('key').textContent = s.hasKey ? '已配置' : '未配置';
    document.getElementById('win').textContent = s.window ? '已开' : '未开';
  }).catch(function(){}); }
  setInterval(refresh, 1500); refresh();
</script>
</body>
</html>`

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 2 * 1024 * 1024) { req.destroy(); done(''); return }
      chunks.push(c)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => done(''))
  })
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

fs.mkdirSync(PACKS_DIR, { recursive: true })
// DSH 的技能目录：不存在时建出来，装技能直接落这里
try { fs.mkdirSync(SKILLS_DIR, { recursive: true }) } catch { /* noop */ }
// 上次装到一半留下的临时目录（进程被杀时会有），启动时清掉
try {
  for (const e of fs.readdirSync(SKILLS_DIR)) {
    if (!e.startsWith('.tmp-')) continue
    try { fs.rmSync(path.join(SKILLS_DIR, e), { recursive: true, force: true }) } catch { /* noop */ }
  }
} catch { /* noop */ }

await server.start()
log('[pet-service] PetServer 已启动:', server.origin)
log('[pet-service] 窗口地址:', server.windowUrl)
log('[pet-service] 设置页:', `${server.origin}/settings`)
log('[pet-service] 技能目录:', SKILLS_DIR, '已有', scanSkills().items.length, '个')
// 表情包库：载入失败不影响聊天，只是她不会发图
await loadMemes()

// 长记忆：把上次的对话接回来，重启之后她还记得前几天聊过什么。
//
// 只接回「他说过的」，不接回她自己说过的。
// 原因：把旧的 assistant 回复塞进 history，等于把旧语气钉在上下文最前面，
// 模型会照着那个腔调往下写——换多少次人设都没用，第一句就是"笨蛋爸爸"。
// 现在只留他的话：既知道刚才聊到哪，又不用继承以前的说法。
if (cfg.memory) {
  const seeded = memory.recent(HISTORY_MAX * 2).filter((r) => r.role === 'user').slice(-4)
  for (const r of seeded) history.push({ role: 'user', content: r.text })
  const st = memory.stats()
  log(
    '[memory] 已接回', seeded.length, '句他的话；库里共',
    st.turns, '句 /', st.facts, '条事实 /', st.blocks, '段摘要；',
    '自', st.sinceText || '—', '起',
  )
}

await new Promise<void>((resolve) => {
  ctrl.listen(CTRL_PORT, '127.0.0.1', () => {
    log('[pet-service] 控制端口已启动:', CTRL_PORT)
    resolve()
  })
})

// 真·桌面浮窗（透明置顶）。失败时退回网页版，并给出提示。
const opened = openPetWindow()
if (!opened.ok) {
  log('[pet-service] 未开浮窗（' + opened.reason + '），网页版：' + `${server.origin}/pet`)
}

/* ------------------------------------------------------------------ *
 * QQ 桥：qq-config.json 里 enabled 一开，就跟着 DSH 一起起。
 * 独立进程，崩了自己重连，绝不把鱼拖下水。
 * ------------------------------------------------------------------ */

let qqProc: import('node:child_process').ChildProcess | null = null
let qqRetry: NodeJS.Timeout | null = null
/** 用户点了「下线」就是 false：桥不再自动重拉，直到再点一次上线。 */
let qqWanted = true

function qqEnabled(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'qq-config.json'), 'utf8'))
    return raw.enabled === true
  } catch {
    return false
  }
}

function spawnQqBridge(): void {
  if (!qqEnabled()) {
    log('[qq] qq-config.json 里 enabled 还不是 true，先不启桥')
    return
  }
  if (!qqWanted) {
    log('[qq] 用户点了下线，先不启桥')
    return
  }
  if (qqProc) return
  const bin = path.join(__dirname, 'qq-bridge.mjs')
  qqProc = spawn(process.execPath, [bin], {
    cwd: __dirname,
    env: { ...process.env, QQ_PET_API: `http://127.0.0.1:${PET_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  qqProc.stdout?.on('data', (d) => log('[qq:out]', String(d).trim().slice(0, 400)))
  qqProc.stderr?.on('data', (d) => log('[qq:err]', String(d).trim().slice(0, 400)))
  qqProc.on('exit', (code) => {
    log('[qq] 桥退出', code, '8 秒后重来')
    qqProc = null
    if (qqRetry) clearTimeout(qqRetry)
    qqRetry = setTimeout(() => { if (qqWanted && qqEnabled()) spawnQqBridge() }, 8000)
  })
  log('[qq] 桥已启动')
}

spawnQqBridge()

/* ------------------------------------------------------------------ *
 * 上线 QQ：右键菜单里跟「装扮」并排的那一格
 *
 * 「在线」的唯一判据是 NapCat 的 OneBot WS 端口能不能连上 —— 桥本来就是
 * 每 5 秒重连一次，所以只要那个端口开了，桥自己就会接上去，这里不用管桥。
 * 点按钮要做的事只有一件：把注入了 NapCat 的 QQ 拉起来（和
 * ~/NapCatQQ/启动小鲸鱼QQ.bat 完全一样的参数），然后等端口开。
 *
 * 幂等：已经在线上时点它只回一句「已经在 QQ 上了」，不会重复拉进程。
 * 测试：PET_QQ_DRY=1 时只走流程不真拉 QQ。
 * ------------------------------------------------------------------ */

type QqState = { online: boolean; busy: boolean; note: string }
let qqOnline = false
let qqBusy = false
let qqNote = ''

const qqState = (): QqState => ({ online: qqOnline, busy: qqBusy, note: qqNote })

function pushQq(): void {
  try { server.broadcast({ t: 'qq', ...qqState() } as any) } catch { /* noop */ }
}

function setQq(patch: Partial<QqState>): void {
  if (patch.online !== undefined) qqOnline = patch.online
  if (patch.busy !== undefined) qqBusy = patch.busy
  if (patch.note !== undefined) qqNote = patch.note
  pushQq()
}

function qqConf(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'qq-config.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** NapCat 的 WS 地址（qq-config 的 wsUrl）：连得上就等于 QQ 在线。 */
function napcatTarget(): { host: string; port: number } {
  try {
    // PET_QQ_WS 只在测试里用：指一个关着的端口，就能在不碰真 QQ 的情况下走「拉起」分支
    const u = new URL(String(process.env.PET_QQ_WS || qqConf().wsUrl || 'ws://127.0.0.1:3001'))
    return { host: u.hostname || '127.0.0.1', port: Number(u.port || 3001) }
  } catch {
    return { host: '127.0.0.1', port: 3001 }
  }
}

function probeNapcat(timeout = 600): Promise<boolean> {
  const { host, port } = napcatTarget()
  return new Promise((resolve) => {
    let settled = false
    const sock = net.connect({ host, port })
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/** NapCat 的安装位置 / QQ 路径 / 免扫码用的号，都能在 qq-config.json 的 napcat 里改。 */
function napcatConf(): { dir: string; qqExe: string; number: string; showConsole: boolean } {
  const n = qqConf().napcat || {}
  return {
    showConsole: n.showConsole === true,
    dir: String(n.dir || path.join(os.homedir(), 'NapCatQQ')),
    qqExe: String(n.qqExe || ''),
    number: n.number ? String(n.number) : '',
  }
}

/** 找 QQ.exe：配置里写的 → 默认安装 → versions/ 下的版本目录（和 bat 一个逻辑）。 */
function findQqExe(configured: string): string {
  if (configured && fs.existsSync(configured)) return configured
  const def = 'C:/Program Files/Tencent/QQNT/QQ.exe'
  if (fs.existsSync(def)) return def
  try {
    const versions = 'C:/Program Files/Tencent/QQNT/versions'
    for (const d of fs.readdirSync(versions)) {
      const p = path.join(versions, d, 'QQ.exe')
      if (fs.existsSync(p)) return p
    }
  } catch { /* noop */ }
  return ''
}

/** QQ 是不是已经开着：开着但没接上 NapCat 时，再拉一个会打起来，得先让他关掉。 */
function qqRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      resolve(!err && /QQ\.exe/i.test(String(stdout)))
    })
  })
}

/** 拉起注入了 NapCat 的 QQ（等价于双击 启动小鲸鱼QQ.bat [-q 号]）。 */
async function launchNapcat(): Promise<{ ok: boolean; why: string }> {
  const c = napcatConf()
  if (!fs.existsSync(c.dir)) return { ok: false, why: `找不到 NapCat 目录：${c.dir}` }
  const boot = path.join(c.dir, 'NapCatWinBootMain.exe')
  const hook = path.join(c.dir, 'NapCatWinBootHook.dll')
  if (!fs.existsSync(boot)) return { ok: false, why: '找不到 NapCatWinBootMain.exe' }
  if (!fs.existsSync(hook)) return { ok: false, why: '找不到 NapCatWinBootHook.dll' }
  if (process.env.PET_QQ_DRY === '1') {
    log('[qq] PET_QQ_DRY=1，演练模式不真拉 QQ')
    return { ok: true, why: '' }
  }
  // DRY=2 是「只打印命令」的演练：连真实 QQ 的状态都不想，直接走到打印那一步
  if (process.env.PET_QQ_DRY !== '2' && await qqRunning()) {
    return { ok: false, why: 'QQ 已经开着，但没接上 NapCat —— 先关掉 QQ 再点我，或者点 NapCatQQ\\扫码上线.bat' }
  }

  // 优先走用户的一键脚本：它自带 `chcp 65001`，控制台里中文不会变成乱码。
  // 直接 spawn NapCatWinBootMain.exe 的话，控制台是系统默认代码页（936），
  // NapCat 按 UTF-8 输出的中文就全糊了。
  const bat = path.join(c.dir, '启动小鲸鱼QQ.bat')
  if (fs.existsSync(bat)) {
    const line = `"${bat}"${c.number ? ` -q ${c.number}` : ''}`
    log('[qq] 用一键脚本拉起 QQ：', line)
    if (process.env.PET_QQ_DRY === '2') {
      log('[qq] PET_QQ_DRY=2，只打印命令不执行')
      return { ok: true, why: '' }
    }
    const p = spawn(line, {
      cwd: c.dir,
      detached: true,
      stdio: 'ignore',
      // 默认不给控制台：那个窗口是系统默认代码页（936），NapCat 按 UTF-8 输出，
      // 中文全是乱码，看着像出错。日志照样落在 NapCatQQ\logs 里。
      // 想盯着看就在 qq-config.json 的 napcat.showConsole 打开。
      windowsHide: !c.showConsole,
      shell: true,
    })
    p.on('error', (e) => log('[qq] 拉 QQ 失败', e.message))
    p.unref()
    return { ok: true, why: '' }
  }

  const exe = findQqExe(c.qqExe)
  if (!exe) return { ok: false, why: '找不到 QQ.exe，检查 QQ 装在哪' }

  const env: Record<string, string | undefined> = {
    ...process.env,
    NAPCAT_PATCH_PACKAGE: path.join(c.dir, 'qqnt.json'),
    NAPCAT_LOAD_PATH: path.join(c.dir, 'loadNapCat.js'),
    NAPCAT_INJECT_PATH: hook,
    NAPCAT_LAUNCHER_PATH: boot,
    NAPCAT_MAIN_PATH: path.join(c.dir, 'napcat.mjs'),
  }
  // 宿主环境会带 ELECTRON_RUN_AS_NODE，留着会让 launcher 以纯 node 身份跑
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  const args = [exe, hook]
  if (c.number) args.push('-q', c.number)
  const p = spawn(boot, args, {
    cwd: c.dir,
    env,
    detached: true,
    stdio: 'ignore',
    // 没有 bat 可借 chcp，就别开窗：开出来只会是一屏乱码
    windowsHide: true,
  })
  p.on('error', (e) => log('[qq] 拉 QQ 失败', e.message))
  p.unref()
  log('[qq] 已拉起注入版 QQ', exe, c.number ? `(-q ${c.number})` : '(需要扫码)')
  return { ok: true, why: '' }
}

let qqPoll: NodeJS.Timeout | null = null
/**
 * 防连点的锁：探测和拉起都是 await，期间再点会各拉一个 QQ。
 * 跟 qqBusy 分开 —— busy 是给页面看的「正在上线」，这个只是流程锁。
 */
let qqInFlight = false
const QQ_ONLINE_WAIT_MS = 90_000

/** 菜单里那一格的入口：没上线就把 QQ 拉起来，在线时由 qqGoOffline 收场。 */
async function qqGoOnline(from: string): Promise<void> {
  log('[qq] 收到上线请求（' + from + '）')
  if (qqBusy) { say('已经在开 QQ 了，等它一下嘛'); return }
  if (qqInFlight) { say('我看一眼再说'); return }
  qqInFlight = true
  try {
    await qqBringOnline()
  } finally {
    qqInFlight = false
  }
}

async function qqBringOnline(): Promise<void> {
  qqWanted = true

  if (await probeNapcat()) {
    setQq({ online: true, busy: false, note: '' })
    say('已经在 QQ 上了，喊我一声就回你')
    return
  }

  // 这个按钮就是「上线」，所以桥也得在：enabled 没开就顺手打开
  if (!qqEnabled()) {
    try {
      const f = path.join(PLUGIN_ROOT, 'qq-config.json')
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
      raw.enabled = true
      fs.writeFileSync(f, JSON.stringify(raw, null, 2) + '\n', 'utf8')
      log('[qq] 点了上线，qq-config.json 的 enabled 改成 true')
    } catch (e: any) {
      log('[qq] 写不进 qq-config.json：', e?.message)
    }
  }
  spawnQqBridge()

  const r = await launchNapcat()
  if (!r.ok) {
    setQq({ online: false, busy: false, note: r.why })
    say(r.why)
    log('[qq] 上线失败：', r.why)
    return
  }

  setQq({ online: false, busy: true, note: '正在开 QQ' })
  say('去开 QQ 了，等它自己上线…')

  const deadline = Date.now() + QQ_ONLINE_WAIT_MS
  if (qqPoll) clearInterval(qqPoll)
  qqPoll = setInterval(() => {
    void (async () => {
      if (await probeNapcat(800)) {
        if (qqPoll) { clearInterval(qqPoll); qqPoll = null }
        setQq({ online: true, busy: false, note: '' })
        say('QQ 上线了，来找我说话吧')
        log('[qq] 上线成功：NapCat 端口已开')
      } else if (Date.now() > deadline) {
        if (qqPoll) { clearInterval(qqPoll); qqPoll = null }
        setQq({ online: false, busy: false, note: 'QQ 没起来' })
        say('QQ 没起来，得手动点 NapCatQQ\\启动小鲸鱼QQ.bat 了')
        log('[qq] 上线超时')
      }
    })()
  }, 2000)
}

/** 关掉 QQ.exe / NapCat 引导进程。返回有没有真的关掉东西。 */
function killQq(): Promise<boolean> {
  if (process.env.PET_QQ_DRY === '1' || process.env.PET_QQ_DRY === '2') {
    log('[qq] 演练模式，不真关 QQ')
    return Promise.resolve(false)
  }
  const killOne = (name: string) => new Promise<boolean>((resolve) => {
    execFile('taskkill', ['/F', '/T', '/IM', name], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(!err || /成功|SUCCESS/i.test(String(stdout)))
    })
  })
  return Promise.all([killOne('QQ.exe'), killOne('NapCatWinBootMain.exe')]).then((r) => r.some(Boolean))
}

/** 那一格的另一半：下线。先停桥（不然它会一直重连刷日志），再把 QQ 关掉。 */
async function qqGoOffline(from: string): Promise<void> {
  log('[qq] 收到下线请求（' + from + '）')
  qqWanted = false
  if (qqPoll) { clearInterval(qqPoll); qqPoll = null }
  if (qqRetry) { clearTimeout(qqRetry); qqRetry = null }
  try { qqProc?.kill() } catch { /* noop */ }
  qqProc = null
  const killed = await killQq()
  setQq({ online: false, busy: false, note: '已下线' })
  say(killed ? '那我先下线了，想找我点一下就好' : '桥关了；QQ 本来就没在跑')
  log('[qq] 已下线', killed ? '（QQ 已关闭）' : '（没有 QQ 进程）')
}

/* ------------------------------------------------------------------ *
 * 主动陪聊：沉默一阵后她可能自己开一句。宁可千日不开，不可开口讨嫌。
 *
 * 全部条件都过才掷骰子（默认关，cfg.proactive 真机验证后再开）：
 *   页面在线 / 沉默在窗口内 / 心情不在气头上 / 今日未超量 / 不在安静时段 /
 *   他没晾着上一次的主动（proLastAt 之后他没来过话，就绝不追问）。
 * 发出去的话照常进记忆和 history——她记得自己开过这个头。
 * 测试旋钮（仿 qq-bridge 的环境变量风格）：PRO_FORCE / PRO_SILENCE_MIN / PRO_SILENCE_MAX / PRO_INTERVAL
 * ------------------------------------------------------------------ */

const PROACTIVE_SYS = [
  '你想主动跟他说句话。不是回答，是你自己起的话头。',
  '规则：',
  '- 一句，口语，不超过 20 个字。',
  '- 别问「在吗」「怎么不理我」，别提你们多久没聊——你知道，他也知道。',
  '- 可以是好奇、分享、吐槽、想到他，随此刻的你。',
  '只输出这句话本身，别带引号。',
].join('\n')

const PRO_SILENCE_MIN = Number(process.env.PRO_SILENCE_MIN || 120) * 60_000
const PRO_SILENCE_MAX = Number(process.env.PRO_SILENCE_MAX || 480) * 60_000
const PRO_INTERVAL = Number(process.env.PRO_INTERVAL || 150) * 1000
const PRO_FORCE = process.env.PRO_FORCE === '1'
let proChecking = false

async function maybeProactive() {
  if (!cfg.inner || !cfg.proactive || proChecking || busy) return
  const now = Date.now()
  // 安静时段 00:30–08:00：她这个点更想自己待着（测试 PRO_FORCE 跳过）
  if (!PRO_FORCE) {
    const d = new Date(now)
    const hour = d.getHours() + d.getMinutes() / 60
    if (hour >= 0.5 && hour < 8) return
  }
  const pro = innerProCounters(now)
  if (pro.today >= 2) return
  const lastUser = memory.lastUserTs()
  const silence = now - lastUser
  if (silence < PRO_SILENCE_MIN || silence > PRO_SILENCE_MAX) return
  // 上次主动之后他一个字没回：那扇门先关着，等他来了再开
  if (pro.lastAt > lastUser) return
  // 她自己在气头上不找他——赌气要能持续，这是性格
  if (innerMoodLite(now).v <= -0.35) return
  if (!PRO_FORCE && !petPageConnected) return
  if (!PRO_FORCE && Math.random() > innerProOdds(now)) return
  proChecking = true
  try {
    const im = memory.byKind('impression', 4).map((b) => '- ' + b.text).join('\n')
    const out = await askRaw(
      PROACTIVE_SYS,
      `你现在：${innerMoodPlain(now) || '心情平平的'}\n你最近攒下的印象：\n${im || '（还不多）'}`,
      60,
    )
    const line = out.trim().split('\n')[0].replace(/^["「『]|["」』]$/g, '').slice(0, 40)
    if (!line) return
    say(line)
    memory.remember({ channel: 'desktop', role: 'assistant', text: line })
    history.push({ role: 'assistant', content: line })
    if (history.length > HISTORY_MAX * 2) history.splice(0, history.length - HISTORY_MAX * 2)
    innerProSent(now)
    log('[pro] 主动开口:', line)
  } catch (e) {
    log('[pro] 失败:', (e as Error).message.slice(0, 80))
  } finally {
    proChecking = false
  }
}

setInterval(() => { void maybeProactive() }, PRO_INTERVAL)

// 平时也每隔半分钟探一次：QQ 自己掉了，那一格的灯要跟着灭；
// 反过来，用户自己手动开了 QQ（或者点了下线又改主意），这里把桥接回来。
setInterval(() => {
  if (qqBusy) return
  void probeNapcat(400).then((ok) => {
    if (ok !== qqOnline) {
      setQq({ online: ok })
      log('[qq] 状态变化：', ok ? '在线' : '掉线')
    }
    if (ok && !qqProc && qqEnabled()) {
      log('[qq] 探到 QQ 在线但桥没跑，接回来')
      qqWanted = true
      spawnQqBridge()
    }
  })
}, 30_000)

// 父进程（DSH）退出时一并结束
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    try { petProc?.kill() } catch { /* noop */ }
    process.exit(0)
  })
}
