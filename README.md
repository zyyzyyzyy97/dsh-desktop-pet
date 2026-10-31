# dsh-desktop-pet · DSH 小鲸鱼桌宠

把开源桌宠 **Coopanion** 的那只鲸鱼（Coo）原样搬进 **DSH（DeepSeek Harness）**，做成一个 DSH 插件，
并给它装上一套会**长期成长**的内心：由 DSH 会话事件驱动她思考 / 聆听 / 说话，同时她有自己独立的
聊天链路（自己的模型、自己的记忆库、自己的心情），能看屏幕、能读图、能发表情包、能说话（TTS）、
能听你说话（ASR）、能在 QQ 上陪你聊。

**她不是 DSH 的聊天界面，是桌面上的一个活物。** 她跟 DSH 主体唯一的耦合点是会话事件。

## 仓库里有什么

| 目录 | 是什么 |
|---|---|
| [`dsh-desktop-pet/`](./dsh-desktop-pet/) | **主插件**：鲸鱼桌宠本体 + 心情引擎（inner）+ 长期记忆 + TTS/ASR + QQ 桥 + 换肤/技能 |
| [`dsh-voice-picker/`](./dsh-voice-picker/) | **伴侣插件**：音色工作台，48 种 qwen3-tts 音色试听 + 一键切换小鲸鱼的声音 |
| [`docs/`](./docs/) | 心情引擎设计文档（DESIGN）、开发志（CHANGELOG）、内部备忘（PROJECT-ADDENDUM） |

## 核心特性

- **会话联动**：DSH 会话事件 → 鲸鱼动作（`turn/start`→思考、`user/message`→聆听、
  `assistant/message`→张嘴+气泡、`turn/end`→待机），渲染与 Coopanion 原版逐帧一致。
- **独立聊天**：不依赖 DSH 的模型，自己带一条 OpenAI 兼容聊天链路（DeepSeek / DashScope / 任意兼容网关）。
- **心情引擎（inner）**：mood(v,a) + baseline 连续浮点状态，惰性指数衰减；冲量来自模型标注 +
  启发式 + 冷落档位；注入 system 的是人话（"被吐槽没良心，有点蔫"），**永远不给数字**。
  被冷落会难过、深夜陪聊会困、过夜不算冷落、长聊不会亢奋爆表——都调过。
- **人格自述式生长**：不写死人设。她每 12 句写第一人称日记 + 对他的印象；攒够 80 句新对话重写
  自己的"自画像"；里程碑时刻常驻记忆。关系只报事实（说过 N 句、认识 D 天），**没有阶段剧本**。
- **长期记忆**：node:sqlite 三层（逐句 turns / 长期事实 facts / 日记印象 blocks），桌面与 QQ 共用。
- **视觉与截屏**：能吃图；命中"帮我看看屏幕"类意图时自动截屏带给模型。
- **语音**：qwen3-tts 出声（edge-tts 兜底）+ SenseVoice 本地识别（可选，需另装 sherpa-onnx）。
- **QQ 桥**：OneBot 11 接 NapCat，私聊/群聊（@或叫名字才回）、只发语音模式、表情包，一键上下线。
- **换肤与技能**：/dress 换装页支持从 GitHub 直装角色包；设置页可从 GitHub 装 SKILL 技能。

## 快速开始

环境要求：Windows + [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness)（自带 node 工具链）。
可选：装 [Coopanion](https://github.com/cortico-world/desktop-pet) 可获得透明置顶浮窗（没有也能跑，鲸鱼开在浏览器里）。

```bat
:: 1. 克隆本仓库
git clone https://github.com/zyyzyyzyy97/dsh-desktop-pet.git
cd dsh-desktop-pet

:: 2. 安装主插件依赖（tsx / ws / fflate 等都会装上）
cd dsh-desktop-pet
npm install

:: 3. 完全退出 DSH（托盘图标右键 → Quit，不是关窗口）

:: 4a. 把整个 dsh-desktop-pet 目录拷进 DSH 插件目录
robocopy "%cd%" "%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-desktop-pet" /E

:: 4b. 在 %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml 追加本插件 cordis.patch.yml
::     里的 insert 块（内容见仓库内该文件，直接整段复制即可）

:: 5. 启动 DSH —— 鲸鱼上线（默认浏览器窗口；装了 Coopanion 且配置 petHostExe 后是透明浮窗）

:: 6.（可选）装音色工作台：把 dsh-voice-picker 目录同样拷进 plugins\，
::    并在 cordis.patch.yml 追加它的 insert 块（见 dsh-voice-picker/cordis.patch.yml）
```

装完第一件事：**打开鲸鱼 → 右键 → 设置**，填你的模型 `baseUrl` + `apiKey`（任何 OpenAI 兼容端点；
仓库默认模板指向 `https://api.deepseek.com`，key 留空，鲸鱼会用气泡提醒你去填）。

详细安装说明、配置字段表、排错见 **[dsh-desktop-pet/README.md](./dsh-desktop-pet/README.md)**。

## 性格成长引擎（inner）

> 设计全文见 [docs/DESIGN.md](./docs/DESIGN.md)。一句话版本：**事实说"发生了什么"，
> 心情说"我感觉如何"，她自己写的说"我是谁"——三层永不混。**

- 不做"聊够 N 句突然变亲密"的阶段剧本，没有 trust/closeness 数值。
- 心情是连续的浮点状态，像天气不像剧本：被凶一句约半天缓过来，连冷落四五天才会真蔫。
- 模型只能提交"冲量"，数值由引擎记账并钳制，LLM 全程摸不到数字。
- `GET /api/inner` 看她此刻的内心；`runtime-data/inner-log.jsonl` 是永不清理的黑匣子。
- 主动陪聊默认关（`pet-config.json` 里 `"proactive": true` 打开）：沉默 [2h,8h] 才可能开口、
  一天上限 2 次、他没理上一次就绝不追问。

49 项测试断言（单元 14 / 端到端 21 / 一周情绪仿真 14）+ qwen 真模型两轮实测通过，见 `dsh-desktop-pet/test/`。

## 授权（重要）

- **本插件整包按 AGPL-3.0 发布**（含 vendored 的 [cortico-world-desktop-pet](https://github.com/cortico-world/desktop-pet)，
  其本体为 AGPL-3.0-or-later；本插件桥接未修改其源码）。
- **鲸鱼美术素材不在 AGPL 内，禁止商用**（详见 vendored 包内 THIRD_PARTY_NOTICES.md）。
- Cortico 框架 MIT；其余依赖许可见 [NOTICE.md](./NOTICE.md)。

## 致谢

- [Coopanion / cortico-world-desktop-pet](https://github.com/cortico-world/desktop-pet) —— 鲸鱼、渲染层、PetServer、口型切分
- [DSH / DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 插件宿主与 cordis 框架
- SenseVoice / sherpa-onnx —— 本地语音识别；edge-tts —— TTS 兜底；NapCat —— QQ 协议端
