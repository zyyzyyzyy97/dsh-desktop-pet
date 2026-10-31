# CHANGELOG · 性格插件夜间构建

> 2026-10-30 00:30 受领任务 → 逐轮迭代。源插件目录全程零改动（每轮验证）。

## R0 · 工作区与克隆（00:40-01:00）

- 建立唯一事实源 `D:\性格\RUNNING_NOTES.md`（心跳+交接文档，防上下文压缩丢状态）
- 看门狗自动化（35 分钟巡检，主会话失联时按 RUNNING_NOTES 接管；实测未触发接管）
- robocopy 克隆插件 → `D:\性格\build\dsh-desktop-pet\`（排除：runtime-data 真记忆、日志、qq-bridge.lock）
- 克隆内 `qq-config.json` 改 enabled:false + petApi 指向测试端口——测试场绝不连真 QQ
- 环境勘探：无独立 node → 用 `Coopanion.exe + ELECTRON_RUN_AS_NODE=1`（Node v24.21，自带 node:sqlite）

## R1 · 心情引擎（01:00-01:40）

- 新增 `vendor/inner.ts`：状态/惰性衰减/冲量/措辞/流水
- 单元测试 `test/inner-unit.mjs` 首轮 11/14 → 修三处：
  - UTC/本地日期混用导致 pro 计数不重置 → localDay()
  - 6h 冷落档 -0.08 低于原因句门槛 0.1 永远说不出口 → 档位 -0.1/-0.18/-0.25 + 门槛 0.08
  - 归来微冲量抵消刚入账的冷落 → gap 已入账时跳过
- 深挖出一个浮点边界 bug：`-0.18+0.1 = -0.0799…` 比特级误差卡阈值 → 全状态 q3 三位小数记账
- 深挖出事件被"偷领"：被动结算先撞冷落线时 touch 拿不到事件 → pendingGap 待领队列
- **单元 14/14 全绿**

## R1-接线 · pet-service.ts（01:40-02:00）

- 12 处补丁（每处断言恰好命中一次）：EXTRACT_SYS v2、runLearn 新格式解析+兼容旧数组、
  handleUser 入口 innerTouch、askModel 注入、relationHint 时间感、/api/inner、PET_DEBUG_SYS
- 真模型冒烟：事实抽取正常但 mood 没入账 → learn 原始输出日志 → 模型输出正常，是防抖只留最后一轮的覆盖问题（R3 修）

## R2 · 自画像与重要时刻（02:00-02:30）

- CONSOLIDATE_SYS + maybeConsolidate（80 句新对话 + 12h + 30 句起步三重门槛；不合格保留旧版）
- diaryHint 三段式：画像 → 印象 → 日记；brief 常驻【一直记得的时刻】
- autoMeme 情绪偏置（选哪张，不是发不发）；persona 补"心情也是你自己的东西"
- 端到端测试补场景 5（整合），假模型加日记/整合分支
- **端到端 17/17 全绿**；顺手修测试框架两个坑：
  - 多行 python -c 会被 cmd 截断（此坑三次）→ 一律脚本文件
  - 假服务器不 close 挂住进程 + process.exit 吞崩溃栈 → unref + 不强制退出
  - 克隆 runtime-data 跨运行残留卡整合门槛 → 测试开头清理

## R3 · 学习批量化（02:30-02:40）

- 修复漏标：learnPending 单条覆盖 → 最多攒 3 对合并一次调用
- 回归全绿

## R4 · 主动陪聊（02:40-03:10）

- PROACTIVE_SYS + maybeProactive + 挂 150s 间隔；七重条件 + 概率闸 + 绝不追问
- petPageConnected 标志挂 PetServer 的 onPetConnect/onPetDisconnect
- inner.ts 心情句解出注入头（innerMoodPlain 给主动开口复用）
- 测试旋钮 PRO_FORCE/PRO_SILENCE_MIN/MAX/INTERVAL；场景 6 四断言
- **端到端 21/21 全绿**

## R5 · 一周仿真（03:10-03:35）

- `test/sim-week.mjs`：合成时间直接驱动引擎，一周剧本 + 全程不变量
- 首轮跑出 5 个失败，两个是仿真脚本自己的 bug（at() 相对锚点把事件挤到同一天；
  状态没锚到合成时间轴，被引擎的时钟回拨保护吃掉衰减），**两个是真缺陷**：
  - **唤醒度长聊饱和**：每 2 轮 +0.1 da 对 45min 衰减 → 稳态爆表 1.0 → 加软顶
    `da × max(0, 1 - a/0.85)`，真模型参数下稳态 ≈0.55-0.6（投入但不癫狂）
  - **过夜被当冷落**：睡一觉的 14 小时被扣"他半天没出现了" → 过夜宽宥
    （19 点后走、6-11 点回、<18h → 不扣，只记 provenance）
- **仿真 14/14 全绿**；三件套 49 项断言全绿

## R6 · 收尾（03:35-）

- 真模型终回归：好消息+嗔怪两轮——她记得前情（"看你之前挺为这事头疼的"）、
  被呛能怼（"难道还要我放个烟花？"）、冲量 `被吐槽没良心` dv-0.1 实时入账 ✓
- 修复：端到端的配置还原在崩溃场景下不可靠 → 持久备份文件方案（.test-backup）
- 验证源目录零改动（mtime 全部还是 10-29 原始值，无 inner.ts）
- 清理：调试脚本 ×3、克隆测试残留 runtime-data、测试备份文件
- 文档四件套 + install/rollback.cmd + zip 打包
