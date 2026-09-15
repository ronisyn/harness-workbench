# Roni Workbench · Windows Server 部署与运维手册

> 目标场景：把这套平台交付到客户的 Windows Server 上，**长期无人值守运行**（开机自启、崩溃自动拉起、平台自我重启可用）。
> 服务托管方式＝**WinSW v2.12.0**（XML 包装器），选型依据与官方来源见 `proposals/D2-Windows-Server服务化调研.md`。
> Linux 版部署（systemd + nginx）见 `scripts/PROD-DEPLOY.md`；本文件是它的 Windows 版，不重复它的内容。

---

## 0. 交付物

| 文件 | 用途 |
|---|---|
| `scripts/windows/install-service.ps1` | 幂等安装：前置检查 → 取并校验 WinSW → 生成 `rwtest.xml` → 装/刷新服务 → 启动 → 放行防火墙 → 跑自检 |
| `scripts/windows/uninstall-service.ps1` | 停服务、注销服务，**保留全部业务数据**（只报告留了什么） |
| `scripts/windows/upgrade.ps1` | 升级：**先停服务再 `git pull`** → 按需 `npm ci` → 按需构建前端 → 启动 → 自检；失败停在「服务已停止」的可诊断状态 |
| `scripts/windows/DEPLOY-Windows.md` | 本文件 |

三个脚本都是 Windows PowerShell 5.1 脚本（Windows Server 自带），都要求**管理员终端**，都带 `-WhatIfOnly`（只检查/只打印，不落地）。

> ⚠️ **改这些脚本时不要丢掉文件的 UTF-8 BOM**。Windows PowerShell 5.1 读**不带 BOM** 的 `.ps1` 时按系统 ANSI 代码页解码，脚本里的中文会变成乱码字节、字符串被截断，直接报 `The string is missing the terminator` 之类的语法错（PowerShell 7 没这个问题，所以别只在 PS7 里验证）。
> 用 VS Code / Notepad++ 编辑时保持编码为 `UTF-8 with BOM`；用脚本生成时：
> ```powershell
> $t = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
> [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($true)))   # $true = 带 BOM
> ```

---

## 1. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows Server 2019 / 2022 | WinSW v2.12.0 自包含，不需要 .NET 运行时 |
| 权限 | 本机管理员 | 装/改/删服务、改防火墙都要管理员 |
| Node.js | **≥ 18**（建议当前 LTS） | 官方 `.msi` 标准安装到 `C:\Program Files\nodejs`；**不要用 nvm-windows**（见 §5.3） |
| Git | Git for Windows | 用于升级；安装时保持默认（含 `git.exe` 在 PATH） |
| 目录 | 无空格、无中文的路径 | 例：平台 `C:\rw-test`；包装器 `C:\rw-test\svc`。XML 里是绝对路径，带空格要额外引号，能避就避 |
| 出网 | 能访问 github.com、npm registry、模型 API、远端 MySQL | WinSW 从官方 release 下载（仅安装时用一次）；npm 装依赖；运行期要能连模型与数据库 |
| 数据库 | **远端 MySQL**，不在本机 | 装库不是本手册的范围；只要客户机网络能连通并在 `.env` 里配好 |
| 前端 | 由平台自身托管 | `server/index.js` 直接服务 `web/dist`，**不需要 IIS / nginx** |

**必须先准备好的两样东西**（安装脚本会核对）：

1. 平台代码目录里已有 `.env`（见 §2.2）。
2. 业务数据目录与平台目录**不在同一个盘也没关系**，但要落在持久盘上；日志与后台任务日志**不要用 `%TEMP%`**。

---

## 2. 环境变量

### 2.1 平台的环境事实（唯一事实源）

`server/env.js` 是环境事实的**唯一出处**（路径、服务名、搜索后端、临时目录），本手册不复制它的内容。
下表只说明「交付时该不该配、配成什么」：

| 变量 | 含义 | 默认 | 本部署怎么处理 |
|---|---|---|---|
| `RW_PLATFORM_DIR` | 平台代码目录 | 由 `server/env.js` 自身位置推导 | **不必配**。安装脚本会显式写进服务环境变量（等于把推导结果固定下来） |
| `RW_WORKSPACE` | Agent 工作区 | 平台目录的兄弟目录 `..\rw-workspace` | 安装脚本写 `-Workspace` 的值，默认即兄弟目录 |
| `RW_JOBS_DIR` | 后台任务日志目录 | `%TEMP%\rw-jobs` | **无人值守部署必须改到持久盘**（见 §5.2）。安装脚本默认写成 `<平台目录>\logs\jobs` |
| `RW_SERVICE` | 服务名（平台 self-heal 用） | `rw-test` | 安装脚本写 `-ServiceName` 的值 |
| `RW_RESTART_CMD` | 平台自我重启命令 | 空＝无自动重启 | **必须配**，否则 Agent 改完自己代码后无法自我重启。安装脚本默认写成 `"<包装器>\rwtest.exe" restart!` |
| `SEARXNG_URL` | 联网搜索后端 | `http://127.0.0.1:8888` | SearXNG 是**可选外部组件**，见 §7.3 |
| `PORT` | 服务监听端口 | `3000`（`server/config.js`） | 本部署用 **880**，写在平台 `.env` 里；安装脚本会用 `-Port` 核对一致性 |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASS` | 远端 MySQL | `127.0.0.1` / `3306` / `rw_dev` | 客户机上**必须**指向真实远端库 |
| `SESSION_SECRET` / `RW_ADMIN_USER` / `RW_ADMIN_PASS` | 会话密钥与内置管理员 | 见 `server/config.js` | `RW_ADMIN_PASS` 必须设，否则自检跑不了 |

各变量的精确默认值与推导规则，以 `server/env.js` 为准（**一处事实源，不在此复制**）。

### 2.2 客户机 `.env` 示例（放在平台目录下）

```ini
PORT=880
DB_HOST=10.0.0.21
DB_PORT=3306
DB_USER=rw_app
DB_PASS=<远端库密码>
DB_NAME=rw_prod
SESSION_SECRET=<一长串随机值>
RW_ADMIN_USER=Ronisyn
RW_ADMIN_PASS=<管理员密码>
DEEPSEEK_API_KEY=<...>
```

`.env` 已被 `.gitignore` 忽略，`git pull` 不会覆盖它 —— 这是它适合放客户机专属配置的原因。

### 2.3 安装脚本会写进服务 XML 的环境变量

安装脚本把下面这些写进 WinSW 的 `<env>`，保证**服务进程**拿到的就是这台机器的真实事实（而不是靠进程外面的环境变量碰运气）：

`RW_PLATFORM_DIR`、`RW_WORKSPACE`、`RW_JOBS_DIR`、`RW_SERVICE`、`RW_RESTART_CMD`、`NODE_ENV=production`

---

## 3. 安装

在**管理员 PowerShell**里（`-ExecutionPolicy Bypass` 是为了绕开从网络拷来的脚本被标记为「未信任」的问题）：

```powershell
cd C:\rw-test
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-service.ps1 -PlatformDir C:\rw-test
```

想先看看会发生什么、又不动本机任何东西：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-service.ps1 -PlatformDir C:\rw-test -WhatIfOnly
```

安装脚本按顺序做这些事，**任何一步失败都会明确报错、说清怎么回退，并退出码 1**：

1. 管理员权限、包装器名合法性（WinSW 的服务 `<id>` 只能用字母数字）
2. 平台目录 / `server\index.js` / `package.json` / `server` 目录
3. `node -v` 版本（<18 直接报错）、`npm`、`git` 是否可用；node 在用户目录下会警告
4. `.env` 的 `PORT` 与 `-Port` 是否一致；`DB_HOST` 是否仍指向本机（本部署数据库在远端）
5. 跑一遍 `server/env.js`，打印它自己推导出的 `RW_WORKSPACE` / `RW_JOBS_DIR`，与将要写进 XML 的值比对
6. 创建目录（工作区、包装器目录、日志、后台任务日志）
7. 端口占用检查（列出占用进程 PID）
8. 依赖与前端：`node_modules` 缺失才 `npm ci`；`web/dist/index.html` 缺失才 `npm run build`
9. 下载 WinSW v2.12.0（已存在且字节数匹配则跳过），校验：官方发布页的字节数 + PE 头（MZ）
10. 生成 `svc\rwtest.xml` 并现场解析一遍（元素名写错会立刻暴露）
11. 装服务：**没注册过 → `install`；已注册 → `refresh`**（`install` 对已存在的服务会以 1073 失败，所以不能无脑 `install`）
12. 启动服务并等 `Running`（最长 60 秒）
13. `netsh advfirewall` 放行入站 TCP 880（同名规则已存在则跳过）
14. 跑 `scripts/selfcheck.mjs` 并**原样打印**全部结果

常用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-PlatformDir` | 按脚本位置推导 | 平台代码目录 |
| `-Workspace` | 平台目录的兄弟目录 `rw-workspace` | Agent 工作区 |
| `-ServiceDir` | `<平台目录>\svc` | 包装器与 XML 的位置 |
| `-JobsDir` | `<平台目录>\logs\jobs` | `RW_JOBS_DIR`，必须在持久盘 |
| `-Port` | `880` | 必须与 `.env` 的 `PORT` 一致 |
| `-ServiceName` | `rw-test` | 平台内部服务名（`RW_SERVICE`）与显示名 |
| `-WrapperName` | `rwtest` | 包装器文件名，也是 Windows 服务名；只能字母数字 |
| `-NodeExe` | 从 PATH 找 | 服务要绑**绝对路径**的 `node.exe` |
| `-RestartCmd` | `"<ServiceDir>\rwtest.exe" restart!` | `RW_RESTART_CMD` |
| `-AdminUser` / `-AdminPass` | 从 `.env` 读 | 自检用 |
| `-SkipDownload` `-SkipBuild` `-SkipFirewall` `-SkipSelfCheck` `-WhatIfOnly` | — | 按需跳过 |

---

## 4. 验证

### 4.1 四条命令

```powershell
# ① 服务状态（WinSW 的 status：Started / Stopped / NonExistent）
& C:\rw-test\svc\rwtest.exe status
Get-Service rwtest | Select-Object Name, DisplayName, Status, StartType

# ② 首屏日志（stdout / stderr / 包装器自身）
Get-Content C:\rw-test\svc\logs\rwtest.out.log -Tail 50
Get-Content C:\rw-test\svc\logs\rwtest.err.log -Tail 50

# ③ 自检（脚本会原样打印每一步 ✅/❌，最后一行是 "N passed, M failed"）
node C:\rw-test\scripts\selfcheck.mjs http://127.0.0.1:880 Ronisyn <管理员密码>

# ④ 从另一台机器打端口（把 10.0.0.5 换成本机 IP）
Test-NetConnection -ComputerName 10.0.0.5 -Port 880
```

### 4.2 必须人工做一次的验收（脚本不能替你做）

- [ ] **开机自启**：`Restart-Computer`，重启后 `& C:\rw-test\svc\rwtest.exe status` 应为 `Started`
- [ ] **崩溃拉起**：`Stop-Process -Name node -Force`，等约 10 秒，服务应自动回到 `Running`（`<onfailure action="restart" delay="10 sec"/>`）
- [ ] **平台自我重启**：在平台里让 Agent 调 `reload_platform`（或改一处自己的代码），服务应在当前回复结束后约 2 秒内自动重启并恢复
- [ ] **页面**：浏览器打开 `http://<客户机IP>:880`，用 `RW_ADMIN_USER` / `RW_ADMIN_PASS` 登录
- [ ] **另一台机器访问**：从客户内网另一台机器打开上面的地址（验证防火墙确实放行）
- [ ] **日志轮转**：`svc\logs` 下单文件不超过 10MB、最多留 8 个

---

## 5. 日志与排查

### 5.1 日志在哪

| 日志 | 路径 | 内容 |
|---|---|---|
| 平台 stdout | `<ServiceDir>\logs\rwtest.out.log` | 平台自己打印的正常输出 |
| 平台 stderr | `<ServiceDir>\logs\rwtest.err.log` | 未捕获异常、启动期报错 —— **起不来先看这个** |
| 包装器自身 | `<ServiceDir>\logs\rwtest.wrapper.log` | WinSW 的角度：装/启/停过程、SCM 交互错误 |
| 后台任务日志 | `RW_JOBS_DIR`（默认 `<平台目录>\logs\jobs`） | `run_long_task` 的 `job-<时间戳>.log`，按 jobId 取回 |
| Windows 事件日志 | 事件查看器 → Windows 日志 → 应用程序 | 源名＝`rwtest`（服务名）；服务没有及时响应控制请求（1053）之类会出现在这里 |

轮转由 WinSW 负责：单文件 10MB（`sizeThreshold=10240` KB）滚动一次，保留 8 个（`keepFiles=8`）。滚动后的历史文件形如 `rwtest.1.out.log`。**包装器日志 `*.wrapper.log` 不参与轮转**，长期跑要顺手看一眼大小。

### 5.2 故障排查

**① 外网访问不到（本机 curl 通、别的机器不通）**

```powershell
# 看规则在不在
netsh advfirewall firewall show rule name="rw-test 880"
# 不在就补
netsh advfirewall firewall add rule name="rw-test 880" dir=in action=allow protocol=TCP localport=880
# 再确认没有别的方向性问题
Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultInboundAction
```
另外确认客户网络侧（云安全组 / 硬件防火墙）有没有放行 880。

**② 后台任务日志被系统清掉 / 任务取不回日志**

Windows Server 2019/2022（带桌面体验）在登录会话超过 7 天时，**SilentCleanup（cleanmgr.exe）会删掉带会话 ID 的 `%TEMP%`**，这是 by design（微软支持文档 KB4506040）。所以 `RW_JOBS_DIR` 绝不能留在 `%TEMP%`。

```powershell
# 查当前服务实际拿到的值：看安装时生成的 XML
Select-String -Path C:\rw-test\svc\rwtest.xml -Pattern 'RW_JOBS_DIR'
```
若发现它仍在 `%TEMP%` 下：改 `-JobsDir` 重跑安装脚本（它会 `refresh` 服务配置），然后重启服务。

**③ nvm-windows 与服务账户不匹配（服务起不来 / 1053）**

nvm-windows 切换版本靠替换 `C:\Program Files\nodejs` 目录或符号链接。服务 XML 里绑的是**绝对路径**的 `node.exe`，切版本后这个路径可能指向失效目标，服务就起不来。规避：

- 服务只绑**标准安装**的 `C:\Program Files\nodejs\node.exe`；
- 要升级 Node：装新的官方 `.msi`（覆盖安装同一路径）→ `& svc\rwtest.exe refresh`（若路径变了）→ `& svc\rwtest.exe restart`；
- 别把服务指向 `%AppData%\...` 下的 node（服务账户读不到）。

**④ `git pull` 报 EPERM / EBUSY（文件锁）**

Windows 上运行中的 Node 进程会占用已加载的文件，git 覆盖会失败。**顺序永远是：先停服务 → 再 pull → 再起服务**，`upgrade.ps1` 就是按这个顺序写的。

```powershell
& C:\rw-test\svc\rwtest.exe stop
git -C C:\rw-test pull --ff-only
& C:\rw-test\svc\rwtest.exe start
```
若已卡住：确认 `node.exe` 都退了（`Get-Process node -ErrorAction SilentlyContinue`），再 pull。也可用 `upgrade.ps1 -WhatIfOnly` 先看它打算做什么。

**⑤ 服务账户权限**

WinSW 默认以 **LocalSystem** 安装（机器上最高权限，能读 node.exe、读写平台目录）。若客户要求最小权限，改用专用账户要同时满足：

- 该账户能读 `node.exe` 与整个平台目录，能**读写** `<ServiceDir>` 与 `logs`；
- 装服务时要带上账户密码（改 XML 的 `<serviceaccount>`，或 `rwtest.exe install /p` 交互输入）；
- `<allowservicelogon>true</allowservicelogon>` 会自动授予「作为服务登录」；
- 日志目录**不要**放在该账户自己的 `%TEMP%` 下（见 ②）。

改账户后：`rwtest.exe uninstall` → `rwtest.exe install` → `rwtest.exe start`（账户变更 `refresh` 不生效）。

**⑥ 服务 `NonExistent` / 1060**

服务没注册或名字写错。注意两个名字的区别：**Windows 服务名＝XML 的 `<id>`＝`rwtest`**（`sc.exe`、`Get-Service -Name` 用它），**显示名＝`rw-test`**（服务管理器里看到的名字，也是平台的 `RW_SERVICE`）。

**⑦ 端口 880 被别的进程占用**

```powershell
Get-NetTCPConnection -State Listen -LocalPort 880 | Select-Object OwningProcess
Get-Process -Id <上面的PID>
```

**⑧ 排错用的通用命令**

```powershell
& C:\rw-test\svc\rwtest.exe status          # Started / Stopped / NonExistent
& C:\rw-test\svc\rwtest.exe stop
& C:\rw-test\svc\rwtest.exe start
& C:\rw-test\svc\rwtest.exe restart          # 前台重启（会等你看到结果）
& C:\rw-test\svc\rwtest.exe restart!         # 平台自我重启用的入口（从子进程调用）
& C:\rw-test\svc\rwtest.exe refresh          # 重读 XML 并把配置变更推给 SCM（不重启进程）
```

`sc.exe` 的常见错误码：`1060` 服务不存在、`1062` 服务未启动、`1053` 服务没有及时响应（典型是包装器或路径写错）、`5` 拒绝访问（没用管理员终端）。

---

## 6. 升级

```powershell
powershell -ExecutionPolicy Bypass -File C:\rw-test\scripts\windows\upgrade.ps1 -PlatformDir C:\rw-test
```

顺序（**不要改**）：前置检查（管理员 / git 工作区 / 未提交改动提示）→ 备份 `package.json`+`package-lock.json` → **停服务** → `git pull --ff-only` → 依赖清单变了才 `npm ci` → 依赖变了或 `web/dist` 缺失才 `npm run build` → 启动 → 自检。

失败时服务**停在停止状态**（可诊断），脚本会打印升级前后 commit 与手工继续/回退命令。回退：

```powershell
& C:\rw-test\svc\rwtest.exe stop
git -C C:\rw-test reset --hard <升级前的 commit>
npm ci                      # 若依赖也回退了
& C:\rw-test\svc\rwtest.exe start
```

**平台自我改代码与升级**：平台的 Agent 在 `write` 权限下不能改平台代码，在 `full` 权限下可以；改完之后它调 `reload_platform` 触发 `RW_RESTART_CMD`（即 `rwtest.exe restart!`）自我重启。这会让平台目录变成「有本地改动」的 git 工作区，下次 `upgrade.ps1` 的 `git pull` 可能因此失败——这是设计上的取舍（改代码的人要负责提交），不是脚本缺陷。

---

## 7. 卸载

```powershell
powershell -ExecutionPolicy Bypass -File C:\rw-test\scripts\windows\uninstall-service.ps1 -ServiceDir C:\rw-test\svc
```

只做三件事：停服务 → 注销服务 → 报告保留了什么。**不删除任何业务数据**：

| 不会被删的东西 | 位置 |
|---|---|
| 远端 MySQL 数据库 | 不在本机，脚本完全不接触 |
| 平台代码与 `.env` | `C:\rw-test`（含 `node_modules`、`web\dist`） |
| Agent 工作区 | `C:\rw-workspace`（含 `uploads\`、`skills\`） |
| 服务日志 | `C:\rw-test\svc\logs` |
| 后台任务日志 | `C:\rw-test\logs\jobs` |
| 包装器与 XML | `C:\rw-test\svc\rwtest.exe` / `rwtest.xml` |
| 防火墙规则 | 保持原样 |

要彻底清理，请人工确认后再删（脚本不会替你决定）。卸载后 WinSW 会在事件日志的 Application 源里留下注册信息，属正常现象。

---

## 8. Windows 上**还没有**的东西（如实说明）

| 缺失项 | 影响 | 现状 |
|---|---|---|
| `scripts/guard-deploy.sh` | 「孤儿提交防护」的安全部署流程在 Windows 上没有等价物 | 该脚本是 bash，且第一行就 `cd /srv/harness-workbench`，Windows 上跑不了。Windows 侧目前只有 `upgrade.ps1`（先停服务再 pull，不做 bundle 校验与未推送提交防护） |
| `scripts/orphan-scan.sh` | 没有「未推送/未引用提交」扫描 | 同上，bash 脚本。Windows 上要查请手工：`git -C C:\rw-test log --oneline origin/main..HEAD` |
| 其它 `scripts/*.mjs` 运维脚本 | 未在 Windows 上验证过 | `selfcheck.mjs` 之外的脚本（`verify.mjs`、`security-check.mjs`、`kpi.mjs` 等）都是 Node 脚本，理论可跑，但**本手册没有在 Windows 上逐个验证**，不要当作已交付能力 |
| SearXNG（`SEARXNG_URL`） | **联网搜索能力不可用** | SearXNG 是可选外部组件，默认指向 `http://127.0.0.1:8888`。客户机上没有部署它，`web_search` 工具就取不到搜索结果 —— 平台会如实报错，**不会假装能搜**。要启用需另装 SearXNG（Docker 或 Python），本手册不覆盖 |
| systemd 单元 / nginx 反代 / acme.sh 证书 | Windows 上没有这套 | `scripts/PROD-DEPLOY.md` §2–§4 与 `scripts/nginx-rw.conf` 都是 Linux 的。Windows 上服务由 WinSW 托管；平台自身直接提供 HTTP（880），**无内置 HTTPS**。要 HTTPS 得在客户网络里放反代（IIS ARR / nginx for Windows）或加证书，本次未交付 |
| 团队侧的部署守护定时任务 | 未迁移 | Linux 侧靠 systemd 定时器/计划任务跑的巡检（如 `guard-deploy`）在 Windows 上没有对应物 |
| WinSW 官方校验和 | 官方 v2.12.0 release **没有发布 SHA256** | 安装脚本用「发布页字节数 `18243033` + PE 头（MZ）」做完整性核对，**不是**密码学校验。要求严格校验的客户，请在可信机器上下载后一并核对文件哈希再拷入（脚本支持 `-SkipDownload` 用已有文件） |

另外两件**尚未在真实客户机上验证**的事（本手册作者只做了语法与静态检查，没有装服务、没有下载 WinSW、没有改本机防火墙）：

1. **`restart!` 在服务身份下确实能自我重启** —— 官方文档与源码都说它要求提权调用，而服务身份是 LocalSystem（比管理员更高），所以预期可行；但必须按 §4.2 实测一次。
2. **`-WhatIfOnly` 的完整干跑** —— 该模式下脚本不写文件、不下载、不动服务与防火墙，但其中若干分支（如端口占用、`env.js` 探针）只有真机上才有意义。

---

## 9. 与 Linux 部署的对应关系

| 关心的事 | Linux（`scripts/PROD-DEPLOY.md`） | Windows（本文件） |
|---|---|---|
| 进程托管 | systemd 单元 | WinSW v2.12.0 包装器 |
| 开机自启 | `systemctl enable` | `<startmode>Automatic</startmode>`（SCM 自动启动） |
| 崩溃拉起 | `Restart=always` + `RestartSec=3` | `<onfailure action="restart" delay="10 sec"/>` |
| 自我重启 | `systemctl restart <RW_SERVICE>` | `"<ServiceDir>\rwtest.exe" restart!` |
| 日志 | `journalctl -u` | `<ServiceDir>\logs\*.out.log / *.err.log / *.wrapper.log`（自带轮转） |
| 升级 | `git pull` + `npm ci` + `npm run build` + `systemctl restart` | `upgrade.ps1`（先 stop，再 pull/ci/build，再 start） |
| 端口放行 | 安全组 / iptables | `netsh advfirewall firewall add rule ...` |
| HTTPS | nginx + acme.sh | **未交付**（见 §8） |
| 数据库 | 远端 MySQL | 远端 MySQL（同一套） |

---

## 10. 附：WinSW 配置要点（`svc\rwtest.xml`）

安装脚本生成的 XML 元素名逐个对照官方规格
（<https://github.com/winsw/winsw/blob/v2/doc/xmlConfigFile.md>），关键项：

```xml
<service>
  <id>rwtest</id>                    <!-- 只能用字母数字；这就是 Windows 服务名 -->
  <name>rw-test</name>               <!-- 显示名；＝平台的 RW_SERVICE -->
  <startmode>Automatic</startmode>
  <executable>C:\Program Files\nodejs\node.exe</executable>
  <arguments>server\index.js</arguments>
  <workingdirectory>C:\rw-test</workingdirectory>
  <logpath>C:\rw-test\svc\logs</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <env name="RW_JOBS_DIR" value="C:\rw-test\logs\jobs"/>
  <!-- …RW_PLATFORM_DIR / RW_WORKSPACE / RW_SERVICE / RW_RESTART_CMD / NODE_ENV… -->
</service>
```

- 文件必须与包装器**同名同目录**（`rwtest.exe` + `rwtest.xml`），否则 WinSW 直接报错。
- 改完 XML 用 `rwtest.exe refresh` 推给 SCM（`<env>` 之类的启动参数要 `restart` 才生效）。
- 服务默认账户是 **LocalSystem**（官方文档明写）。
