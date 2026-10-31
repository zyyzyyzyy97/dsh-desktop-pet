# dsh-desktop-pet · DSH 小鲸鱼桌宠插件

DSH（DeepSeek Harness）桌宠插件：把开源桌宠 **Coopanion**（`cortico-world-desktop-pet`）的
**鲸鱼（Coo）**原样搬进 DSH，由 DSH 会话事件驱动它思考 / 聆听 / 说话；同时它自己有一条
**独立聊天链路**（自己的模型、自己的长期记忆、自己的心情引擎），能看屏幕、能读图、
能发表情包、能说话（TTS）、能听你说话（ASR）、能在 QQ 上陪你聊。

> ⚠️ **授权提醒**：Coopanion 本体 `cortico-world-desktop-pet` 为 **AGPL-3.0**。本插件只是桥接、
> 未修改其源码，随本仓库整包按 AGPL-3.0 开源分发。其**鲸鱼美术素材禁止商用**（详见
> `vendor/cortico-world-desktop-pet/THIRD_PARTY_NOTICES.md`）。框架 `cortico` 为 MIT。

## 架构

```
DSH 会话事件 ──► src/index.js（DSH Cordis 插件，极薄）
                     │  POST /control
                     ▼
              vendor/pet-service.ts（独立 Node 子进程，用 tsx 运行）
                     │  复用 Coopanion 原版：
                     │   · PetServer (src/server.ts)   —— HTTP+WS，鲸鱼渲染 100% 原样
                     │   · parseScript(src/script.ts)   —— 文本→beats，口型一致
                     │   · web/                         —— canvas 骨骼+贴图+气泡+装扮
                     ├─ vendor/inner.ts                —— 心情引擎（喜怒哀乐的连续性）
                     ├─ vendor/memory.ts               —— 三层长期记忆（node:sqlite）
                     ├─ vendor/qq-bridge.mjs           —— OneBot 11 桥（连 NapCat）
                     └─ vendor/shot.py / tts_edge.py   —— 截屏 / TTS 兜底
                     ▼
              浏览器 / Coopanion Electron 透明浮窗渲染鲸鱼（与原版逐帧一致）
```

要点：

- 渲染、骨骼、气泡、装扮全部来自 vendored 的 `cortico-world-desktop-pet`（原样复制、未改源码）。
- `pet-service.ts` 另起一个本地控制端口（默认 18766）接收 DSH 转发的会话事件，再调 `PetServer.sendPet(...)`。
- 运行 TS 需要 tsx：`src/index.js` 自动解析（插件 npm 自带的 tsx 优先，其次已装 Coopanion 的 tsx），
  也可以在插件配置里手动指定 `coopanionTsx`。

## 目录结构

```
dsh-desktop-pet/
├─ package.json            # Cordis 插件清单（peer: @deepseek-ai/cordis / schemastery）
├─ cordis.patch.yml        # DSH bundle patch（insert 到 profile 根）
├─ pet-config.json         # 人设 / 模型 / 开关（发布模板：apiKey 为空，填上你的就能聊）
├─ qq-config.json          # QQ 桥配置（默认关闭）
├─ pet-skin.json           # 当前皮肤（落盘，重启保持）
├─ src/index.js            # DSH 插件入口：订阅会话事件、spawn pet-service、暴露 ctx.pet
├─ vendor/
│  ├─ pet-service.ts       # 核心：PetServer + 聊天/视觉/截屏/TTS/记忆/技能/设置页
│  ├─ inner.ts             # ★ 心情引擎（mood/baseline/冲量/衰减/注入）
│  ├─ memory.ts            # 三层长期记忆（turns/facts/blocks）
│  ├─ qq-bridge.mjs        # OneBot 11 桥（独立进程，崩了不影响鲸鱼）
│  ├─ shot.py / tts_edge.py / pylibs/   # 截屏（纯标准库）/ edge-tts 兜底
│  ├─ cortico-world-desktop-pet/        # ★ 原样复制 Coopanion 本体（AGPL-3.0）
│  └─ node_modules/        # vendored 运行时依赖（cortico 为打过路径补丁的 MIT 副本）
└─ test/                   # 全部验证脚本（见「测试」节）
```

## 快速开始

环境要求：Windows + DSH Desktop（自带 node 工具链，插件会自动找到真 node 而不是 Electron）。

```bat
:: 1. 克隆仓库后进到本目录
cd dsh-desktop-pet

:: 2. 装依赖（tsx / ws / fflate / jpeg-js / opencc-js，peer 的 cordis+schemastery 也会装上）
npm install

:: 3. 完全退出 DSH（托盘图标右键 → Quit，不是关窗口）

:: 4. 把整个目录拷进 DSH 的 desktop profile 插件目录
robocopy "%cd%" "%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-desktop-pet" /E

:: 5. 在 %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml 里追加本目录
::    cordis.patch.yml 的 insert 块（整段复制即可）：

- insert:
  - id: desktop-pet
    name: dsh-desktop-pet
    config:
      petPort: 18765
      ctrlPort: 18766
      autoOpen: true

:: 6. 启动 DSH —— 鲸鱼上线（浏览器窗口；配了 Coopanion 浮窗后是透明置顶窗）
```

> ⚠️ 改 DSH profile 前请**完全退出 DeepSeek Harness Desktop**（否则 `cordis.patch.yml` /
> 插件目录被占用）。建议先备份 `%USERPROFILE%\.dsh\profiles\desktop\`。

> 验证 DSH 是否识别：`dsh --dump-config --profile desktop` 应能看到 `id: desktop-pet` 且无
> `not found` 警告。注意：**新增的本地插件必须用 `insert`**，不能写成 `id` 覆盖式（不存在的
> entry 会被静默跳过）；`name` 必须用裸包名 `dsh-desktop-pet`，**不能写 `.`**（Loader 会把
> `.` 解析成 profile 根目录，报 `ERR_UNSUPPORTED_DIR_IMPORT` 后静默丢弃）。

### 首次配置（必做）

鲸鱼启动后右键它 → **设置**（或开 `http://127.0.0.1:18765/settings`）：

- `baseUrl` + `apiKey`：任何 OpenAI 兼容端点（发布模板默认 `https://api.deepseek.com` / 模型
  `deepseek-chat`，key 留空）。没填 key 时鲸鱼会用气泡提醒并自动弹设置窗。
- 保存即生效（内存热生效 + 落盘 `pet-config.json`）。

> 之前装过基础版、想升级到本版并**保留她的记忆**？看 [../docs/UPGRADE.md](../docs/UPGRADE.md)。

### 配置参考（pet-config.json 全部字段）

代码内默认值见 `vendor/pet-service.ts` 的 `DEFAULTS`；`pet-config.json` 里写了的键会覆盖默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `name` | `"Coo"` | 鲸鱼的名字（气泡/记忆里用） |
| `baseUrl` | `https://api.deepseek.com` | OpenAI 兼容端点 |
| `apiKey` | `""` | 模型 key，留空时气泡提醒并弹设置窗 |
| `model` | `deepseek-chat` | 模型名 |
| `temperature` | `0.85` | 采样温度 |
| `maxTokens` | `400` | 单条回复上限 |
| `persona` | 内置反人设底座 | 系统提示词底座（自述式生长philosophy，见 docs/DESIGN.md） |
| `petHostExe` | `""` | Coopanion 的 `Coopanion.exe` 路径（透明浮窗用；留空 = 浏览器模式） |
| `autoOpenWindow` | `true` | 启动后自动开浮窗/浏览器窗口 |
| `keepAsking` | `true` | 说完一句自动弹回输入框 |
| `greeting` | `"我在这儿。想聊点什么？"` | 开场白 |
| `vision` | `true` | 命中"帮我看看屏幕"类意图时自动截屏给模型 |
| `screenWidth` | `1100` | 截屏宽度（越大越清楚也越贵，1100 宽约 750 token） |
| `fast` | `true` | 关思考链提速（同图 11.3s → 0.9~2.1s；网关不认自动重试） |
| `memes` | `true` | 发表情包（用 dsh-meme 插件的库；没装库则无图可发） |
| `memePack` | `""` | 指定别的表情包库（留空用 dsh-meme 默认库） |
| `voiceOut` | `true` | 出声：qwen3-tts 主路径，失败回退 edge-tts |
| `ttsVoice` | `"Cherry"` | qwen 音色（Cherry/Serena/Ethan…）；edge 用 `zh-CN-XiaoxiaoNeural` |
| `memory` | `true` | 三层长期记忆总开关 |
| `inner` | `true` | ★ 心情引擎总开关（关掉 = 完全回到没有心情的状态，零残留） |
| `proactive` | `false` | ★ 主动陪聊（默认关；建议真机用一两周再开，见上文 inner 节） |

### 配置参考（qq-config.json 主要字段）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | QQ 桥总开关（随 DSH 一起起） |
| `mode` | `"forward"` | `forward` 连 NapCat 的 WS / `reverse` 监听等 NapCat 来连 |
| `wsUrl` | `ws://127.0.0.1:3001` | NapCat 的 OneBot WS 地址（forward 模式） |
| `listenPort` / `path` | `18767` / `/onebot/v11/ws` | reverse 模式监听 |
| `token` | `""` | OneBot access token（两边要一致） |
| `selfId` | `0` | 机器人 QQ 号（0 = 从 NapCat 上报自动取） |
| `privateReply` / `groupReply` | `true` | 私聊/群聊是否回复 |
| `groupAtOnly` | `true` | 群聊只在 @ 或命中 `aliases` 时回 |
| `aliases` | `["小鲸鱼","Coo","coo"]` | 群里叫这些名字会触发回复 |
| `allow` | `[]` | 白名单（空 = 不限） |
| `maxReplyChars` / `cooldownMs` | `300` / `1500` | 回复长度 / 冷却 |
| `sendVoice` / `voiceOnly` / `sendMeme` | `true` / `false` / `true` | 发语音 / **只发语音**（合成失败才退回发字）/ 发表情包 |
| `napcat.dir` | `""` | NapCat 安装目录（一键上线按钮要用） |
| `napcat.qqExe` | `""` | QQ 客户端路径（留空自动找） |
| `napcat.number` | `0` | 免扫码登录用的 QQ 号 |
| `napcat.showConsole` | `false` | 是否显示 NapCat 控制台窗口 |

## 会话事件映射

| DSH 会话事件 | → 鲸鱼动作 | 说明 |
|---|---|---|
| `turn/start` | `thinking` | 模型开始思考 |
| `user/message` | `listening` | 你在说话（聆听） |
| `assistant/message` | `say {text}` | 模型输出文字 → 张嘴 + 气泡（`parseScript` 切 beats） |
| `turn/end` | `idle` | 回合结束，回到待机 |

其它 DSH 插件也可直接驱动（不经过会话事件）：

```js
ctx.pet.say('你好，我是鲸鱼 Coo')
ctx.pet.act(['wave'])
ctx.pet.status('thinking')
```

## 性格成长引擎（inner）★

这是本插件区别于普通桌宠的部分：**她有会长期生长的内心**。设计全文见
[../docs/DESIGN.md](../docs/DESIGN.md)，这里只说三条铁律和怎么用：

1. **事实说"发生了什么"**（`relationHint` 只报事实：说过 N 句、认识 D 天、上次说话多久前）；
2. **心情说"我感觉如何"**（`vendor/inner.ts`：mood(v,a)+baseline 连续浮点，惰性指数衰减，
   冲量来自模型标注 + 启发式 + 冷落档位，全部钳制记账，LLM 摸不到数字）；
3. **她自己写的说"我是谁"**（每 12 句第一人称日记 + 对你的印象；攒够 80 句新对话重写自画像；
   里程碑时刻常驻记忆。没有阶段剧本、没有 trust/closeness 数值）。

注入 system 的是人话（"被吐槽没良心，有点蔫"），平静时是空串，永远不给数字。
被冷落会难过、过夜不算冷落（19 点后走、6-11 点回、<18h）、深夜长聊不会越聊越蔫、
唤醒度有软顶不会长聊爆表——这些边界都用一周仿真验证过。

| 开关（pet-config.json） | 默认 | 说明 |
|---|---|---|
| `"inner": true` | 开 | 心情引擎总开关，关掉 = 回到没有心情的状态，零残留 |
| `"proactive": false` | 关 | 主动陪聊：沉默 [2h,8h] 才可能开口、日上限 2 次、他没理上一次就绝不追问。建议先用一两周再开 |

调试入口：

- `GET /api/inner` —— 内心快照（mood/baseline/最近事件/注入预览/今日主动计数）
- `PET_DEBUG_SYS=1` 环境变量 —— 每轮 system 前 400 字写进 `pet-service.log`，亲眼看注入
- `runtime-data/inner-log.jsonl` —— 心情流水黑匣子（每次冲量/衰减/冷落都有原因），永不清理

## 独立聊天与记忆

- **聊天**：`POST {baseUrl}/chat/completions`（OpenAI 兼容），system = persona + 记忆 + 心情 +
  表情包菜单，带最近若干轮历史。`enable_thinking:false + thinking:{type:'disabled'}` 提速
  （同一张桌面图 11.3s → 0.9~2.1s；网关不认这两个字段会 400，自动去掉重试一次）。
- **视觉**：直接吃 `image_url`；命中 `SCREEN_INTENT` 正则（"这题/帮我看看/我屏幕上/报错…"）
  自动截屏随问题带上。自己截的屏和 QQ 发来的图用两套提示词（防"风景照被当成糊屏幕"）。
- **长期记忆**：node:sqlite 三层 —— 逐句 `turns` / 长期事实 `facts`（key 唯一、覆盖更新）/ 摘要块
  `blocks`（diary/impression/portrait/moment）。检索中文二字组 + LIKE 候选 + 时间加权。
  库在 `runtime-data/memory.db`，桌面与 QQ 共用。

## 语音

### 出声（TTS）

- 主路径 qwen3-tts（走 DashScope 兼容端点，需要对应 key）；失败自动回退 **edge-tts**（`vendor/tts_edge.py` + vendored pylibs）。
- 回复按文件头存 `.wav`（qwen 实际返回 24k WAV 不是 mp3），`/voice/<sha1>.wav` 静态放行。
- 想换音色：装仓库里的伴侣插件 [dsh-voice-picker](../dsh-voice-picker/)（48 音色试听 + 一键热切换）。

### 听（ASR，可选）

两条独立入口共用本地 SenseVoice 模型：

1. DSH 输入框麦克风（DSH 本体能力）；
2. 鲸鱼工具栏麦克风（本插件实现）：页面录音 → WS 二进制 → 能量 VAD（RMS>320 连 3 帧开口，
   静音 800ms 且有声>320ms 算说完）→ SherpaAsr（复用 Coopanion 原版）→ 走聊天链路。
   界面有"正在听 → 识别中 → 结果"胶囊反馈。

ASR 需要 sherpa-onnx（可选，默认不装也不影响其它功能）：

```
cd vendor\node_modules
npm i sherpa-onnx-node sherpa-onnx-win-x64
```

模型放 `%USERPROFILE%\.dsh\speech-to-text\sensevoice\models\`：
`sensevoice-onnx/model.int8.onnx`（228MB）+ `sensevoice-onnx/tokens.txt` + `silero/silero_vad.onnx`。
SHA256 与包内 `runtime/assets.json` 一致（`node test/verify-speech.mjs` 会核）。

## 桌面浮窗（可选，借 Coopanion 的 Electron）

默认鲸鱼开在浏览器里。想要**透明置顶浮窗**：安装
[Coopanion](https://github.com/cortico-world/desktop-pet)，把 `pet-config.json` 的
`petHostExe` 指到它的 `Coopanion.exe`，`"autoOpenWindow": true`。

- 关键坑：宿主环境常带 `ELECTRON_RUN_AS_NODE=1`，会让 Coopanion.exe 以纯 Node 身份跑而秒退；
  pet-service 拉浮窗时已自动剔除该变量（还有 `NODE_OPTIONS`）。
- `--parent-pid` 让 pet-service 退出时浮窗跟着关；数据目录指向插件 `runtime-data/`，不污染 Coopanion。

## QQ 桥（可选）

`qq-config.json` 里 `"enabled": true` 后随 DSH 一起起 OneBot 11 桥（forward/reverse 双模式，
连 [NapCat](https://github.com/NapNeko/NapCatQQ)）。特性：私聊/群聊（@ 或叫别名才回）、
cooldown 与白名单、一条回复分三条发（字→图→语音）互不牵连、**只发语音模式**（`"voiceOnly": true`，
只有合成失败才退回发字）、表情包、「上线/下线 QQ」按钮（右键菜单企鹅图标）。

- `napcat` 块：NapCat 目录、QQ 号、控制台显示开关。
- 桥有单实例锁（`qq-bridge.lock` + pid 存活检测）；两个桥同时连 3001 会把同一条消息回多遍。
- 桌宠发送链路验证过：手机发消息 → 1.1s 回复 → TTS wav → NapCat `record` → 手机收到语音。

## 换肤与技能

- **换肤**：`http://127.0.0.1:18765/dress`。支持从 GitHub 直装角色包（粘 `github.com/o/r` 链接 →
  codeload zip → 找 `figure.json` → 校验 id ≠ coo → 写 `packs/<id>/`）。
- **技能（Skill）**：设置页可从 GitHub 装 skill 到 `%USERPROFILE%\.dsh\skills\<name>\SKILL.md`。
  frontmatter 必须 `name` + `description`，`name` 匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，
  不合规会被**静默丢弃**（设置页会列红条）。技能按会话生效：装完开新会话。

## 控制台

```
http://127.0.0.1:18766/        # 手动控制台（说话/表情/状态/开换装页/实时状态）
http://127.0.0.1:18765/dress   # 换装
http://127.0.0.1:18765/settings# 设置页
```

表情动作：`wave`挥手 `cheer`欢呼 `bounce`蹦跳 `nod`点头 `shake`摇头 `spin`转圈 `bow`鞠躬
`dance`跳舞 `sit`坐下 `look`张望 `perk`好奇 `heard`听到。

## 测试

全部测试**不碰真实数据**：inner 测试写临时目录；端到端用假模型 + 真实服务进程；
QQ 桥用假 NapCat。端口全部与线上错开（18875+/18797+）。

```bat
:: 单元 14 项（衰减数学/措辞门槛/冷落一次性/损坏自愈/时钟回拨/负面下限…）
node node_modules\tsx\dist\cli.mjs test\inner-unit.mjs

:: 端到端 21 项（假模型 + 真服务进程：注入内容/数字不外漏/冷落归来/自画像/主动开口不追问…）
node node_modules\tsx\dist\cli.mjs test\check-inner.mjs

:: 一周情绪仿真 14 项（过夜宽宥/吵架和好/两天缺席/夜聊不爆表/全程不变量）
node node_modules\tsx\dist\cli.mjs test\sim-week.mjs

:: Cordis 真实加载 + 会话事件端到端（顺带验证 tsx 自动解析）
node node_modules\tsx\dist\cli.mjs test\cordis-real-b.mjs

:: 对着已在跑的实例验证 WS 链路（PET_PORT/CTRL_PORT 可覆盖，默认 18765/18766）
node test\verify-pet.mjs

:: QQ 桥三场景（假 pet + 假 NapCat + 真桥进程 --once）
node test\check-voiceonly.mjs

:: 可选：语音模型核对 / ASR 端到端
node test\verify-speech.mjs
node test\verify-voice-e2e.mjs zh.wav 18765
```

## 排错（已踩过的坑）

| 症状 | 真相 / 解法 |
|---|---|
| 开了 DSH 完全没鲸鱼 | DSH Desktop 是 Electron，`process.execPath` 不是 node。本插件已自动从 `%USERPROFILE%\.workbuddy\binaries\node\versions\*\node.exe` 解析真 node；仍异常看 `plugins/dsh-desktop-pet/plugin.log` |
| 日志说找不到 tsx | 插件目录 `npm install`（依赖自带 tsx），或在 config 里把 `coopanionTsx` 指向现成的 `tsx/dist/cli.mjs` |
| EADDRINUSE 18765/18766 | 只能有一个 pet-service。完全退出 DSH 再开；`netstat -ano | findstr 18765` 查占用 PID |
| 鲸鱼窗口没弹 | `autoOpen` 用系统默认浏览器开 `#key=` 地址；手动开 `http://127.0.0.1:18765/pet` 也能渲染 |
| 改了配置没生效 | `pet-config.json` 是设置页热写的；手改后重启 DSH（完全退出托盘 Quit） |
| 技能装了模型不知道 | frontmatter 必须有合规 `name`+`description`，否则静默丢弃；技能按会话生效 |
| 页面空白 | `/api/figures` 返回 `[]` 多半是 PetServer 漏传 packs；WS init 必须带默认 skin |
| `{t:'type'}` 掐断回复 | say 没播完时到 type 会关气泡；`sayHold ≈ 2200ms + 150ms/字`（宁可偏长） |
| 截屏尺寸不对 | 忘了 `SetProcessDPIAware`，2560×1600 会被读成 1707×1067（缩放画布） |

## 已知边界（诚实记录）

- 设置页不在 DSH 自己的窗口里，是跟随桌宠的同源窗口 —— 插件没有向 DSH 渲染层注入 UI 的能力。
- QQ 语音消息（silk/amr）不能转文字，桥会回一句"打字给我"。
- Coopanion 的 Worlds/providers 依赖 Cortico 运行时，未移植。
- 语音输入用系统默认麦克风；原版的设备切换 UI 与 partial 解码未接。
- 鲸鱼美术素材禁商用；分发须整包 AGPL-3.0 开源（本仓库即是）。

## 许可

- 本插件整包 **AGPL-3.0-or-later**（含 vendored 的 cortico-world-desktop-pet；桥接未修改其源码）。
- 鲸鱼美术素材**不在 AGPL 内，禁止商用**。
- 其余依赖见仓库根 [NOTICE.md](../NOTICE.md)。
