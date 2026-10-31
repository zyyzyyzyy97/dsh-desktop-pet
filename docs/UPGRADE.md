# 从旧版升级（保留她的记忆和配置）

> 适用场景：你之前装过基础版 `dsh-desktop-pet`（没有 inner 心情引擎的版本），现在想换成本仓库的完整版，
> **并且保留**她的全部记忆（`runtime-data/memory.db`）、你的 QQ 桥配置（`qq-config.json`）和换肤（`pet-skin.json`）。

## 原理

插件的一切状态都在插件目录内（记忆库 `runtime-data/`、配置 `pet-config.json` / `qq-config.json` / `pet-skin.json`）。
升级 = 换掉代码目录 + 把这几样状态搬回来，她还是她。

## 步骤（Windows，需管理员权限无所谓）

```bat
:: 0. 完全退出 DSH（托盘图标右键 → Quit，不是关窗口；
::    任务管理器确认没有 msedge/DeepSeek Harness 相关进程占着 18765/18766 端口）

:: 1. 把旧插件目录整个改名留作备份（这就是回滚保险）
cd /d "%USERPROFILE%\.dsh\profiles\desktop\plugins"
ren dsh-desktop-pet dsh-desktop-pet.backup

:: 2. 从本仓库把新目录放进来（假设仓库克隆在 %USERPROFILE%\dsh-desktop-pet）
cd /d "%USERPROFILE%\dsh-desktop-pet\dsh-desktop-pet"
npm install
robocopy "%cd%" "%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-desktop-pet" /E

:: 3. 从备份把状态搬回来（记忆 + QQ 桥配置 + 皮肤）
set NEW=%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-desktop-pet
set OLD=%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-desktop-pet.backup
robocopy "%OLD%\runtime-data" "%NEW%\runtime-data" /E
copy /y "%OLD%\qq-config.json" "%NEW%\qq-config.json"
copy /y "%OLD%\pet-skin.json" "%NEW%\pet-skin.json"
:: （可选）你在旧版手改过 pet-config.json 的话，把它也拷回来，
:: 但注意补上两个新开关："inner": true（默认开）和 "proactive": false（默认关）

:: 4. 启动 DSH —— 鲸鱼上线，记忆还在，从此有了心情
```

## 验证升级成功

- 右键鲸鱼随便聊两句，然后浏览器开 `http://127.0.0.1:18765/api/inner`：
  能看到 `"mood":{"v":..,"a":..}` 和 `hint` 就说明心情引擎在工作。
- `runtime-data/inner-log.jsonl` 开始出现流水（每次冲量/衰减/冷落一行，带原因，永不清理）。

## 回滚（零残留）

```bat
:: 0. 完全退出 DSH
cd /d "%USERPROFILE%\.dsh\profiles\desktop\plugins"
:: 新版整个删掉（先把她这几天的记忆备份出来，如果你在意的话）
robocopy dsh-desktop-pet\runtime-data %USERPROFILE%\Desktop\inner-backup /E
rmdir /s /q dsh-desktop-pet
:: 旧版改回原名
ren dsh-desktop-pet.backup dsh-desktop-pet
:: 1. 启动 DSH —— 回到没有心情引擎的旧版，记忆是搬走前的状态
```

## 注意

- `runtime-data/inner.json`（心情状态）与 `memory.db`（记忆）是独立的：清空记忆不会清心情，反之亦然。
- 新版 `qq-config.json` 的 `enabled` 默认是 **false**——这就是为什么要从备份拷回你自己的那份。
- 从**同一作者的其他机器**迁移也一样：把整个插件目录拷走，`runtime-data` 就是她的全部。
