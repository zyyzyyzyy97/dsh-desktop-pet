# dsh-voice-picker · 桌宠音色工作台

给 [dsh-desktop-pet](../dsh-desktop-pet/) 小鲸鱼配的**音色工作台**：浏览器里试听
**48 种 qwen3-tts 音色**，点一下就切换小鲸鱼说话的声音——经 pet 的 `/api/config` 热生效，
**无需重启 DSH**。

- 试听：页面上每个音色一键生成一段真实 TTS 样例（走小鲸鱼配置里的 DashScope 兼容 key）
- 切换：`POST /api/config { ttsVoice }`，内存即时生效 + 落盘 `pet-config.json`
- 切换成功后鲸鱼自己会说一句"换新声音啦"，你马上能听效果
- **隐私**：小鲸鱼的 apiKey 永远不会传到工作台页面（有专门断言防泄露）

## 安装

和主插件一样的方式（要求主插件 dsh-desktop-pet 已在跑）：

```bat
:: 1. 完全退出 DSH（托盘右键 → Quit）

:: 2. 把本目录整个拷进 DSH 插件目录
robocopy "%cd%" "%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-voice-picker" /E

:: 3. 在 %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml 追加本目录 cordis.patch.yml
::    里的 insert 块（整段复制即可）

:: 4. 启动 DSH，浏览器开 http://127.0.0.1:18768/
```

配置（cordis.patch.yml 的 config 块）：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | 18768 | 工作台监听端口（被占用自动 +1） |
| `petPort` | 18765 | 小鲸鱼 PetServer 端口 |
| `ctrlPort` | 18766 | 小鲸鱼控制端口（切换后让它说确认句） |
| `autoOpen` | false | 启动时自动开浏览器页面 |

无外部 npm 依赖（纯 Node 内置模块），不需要 `npm install`。

## 接口

| 路由 | 说明 |
|---|---|
| `GET /` | 工作台页面 |
| `GET /api/voices` | 48 个音色 + 当前音色 + 小鲸鱼在线状态（key 不回传） |
| `POST /api/apply {voice}` | 热切换音色；鲸鱼说确认句；非法 id 400；pet 离线 502 |
| `POST /api/preview {voice,text}` | 试听，返回 `audio/wav`（走真实 qwen3-tts） |

## 测试

```bat
node test\smoke.mjs        :: 独立冒烟（mock pet + fake TTS，9 项断言）
node test\cordis-load.mjs  :: 真实 cordis 加载 + 服务起 + 列表 48 个
```

两个都需要 Node ≥18；`cordis-load.mjs` 需要装过 DSH（用它自带的 cordis）。

## dev\ 开发工具（可选）

| 脚本 | 用途 |
|---|---|
| `dev\run-picker.mjs [端口]` | 不经 DSH 直接把工作台拉起来（连运行中的小鲸鱼，只读它的配置），Ctrl+C 退出 |
| `dev\test-api.mjs [音色] [文本]` | 验证 qwen3-tts API 调用链（与主插件同款逻辑），音频只写 %TEMP% |
| `dev\qa-check.mjs` / `dev\patrol-preview.mjs` | 音色清单 QA 与预览巡检 |
| `dev\check-voices-vs-official.mjs` | 对照官方音色列表核对 `data/voices.json` |
| `dev\test-disk-cache.mjs` | 音频磁盘缓存行为验证 |
| `dev\test-install.ps1` | 安装形态冒烟（PowerShell） |

全部只读运行中的 pet 配置、不写任何已有文件。

## 许可

MIT（本插件自有代码）。注意试听与切换依赖主插件的 TTS 链路（qwen3-tts 主路径 + edge-tts 兜底）。
