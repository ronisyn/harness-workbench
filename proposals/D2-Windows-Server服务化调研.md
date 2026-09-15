# D2 · Windows Server 上把 Node 服务做成守护进程（调研）

> 范围：Win Server 2019/2022，客户机有公网。结论先行；`[已证]`=官方文档/官方源码写明，`[推断]`=我的判断。
> 一句话结论：**首选 WinSW v2.12（XML 包装器），自我重启就一行 `rwtest.exe restart!`；若客户 IT 禁止任何第三方二进制，退到「任务计划程序 + 看门狗」。两条路都不要用裸 `sc.exe`，也不要用 `nssm stop/start` 当自我重启。**

## 1. 主流做法对比（结论表）

| 方案 | 自启 | 崩溃拉起 | stdout 落盘/轮转 | 自我重启命令 | 需装东西 |
|---|---|---|---|---|---|
| **WinSW v2.12** | `<startmode>Automatic` | `<onfailure action="restart"/>`（SCM 恢复动作） | 自带 `.out.log/.err.log`，支持 roll-by-size/time `[已证]` | `rwtest.exe restart!` | 1 个 18MB 自包含 exe |
| NSSM 2.24 | `nssm install` | `AppExit Default Restart`（包装器内部拉起，带退避节流）`[已证]` | `AppStdout` 重定向；轮转默认阈值 1MB，可配 `AppRotateBytes` `[已证]` | **没有等价命令**（见 §5） | nssm.exe |
| node-windows | `svc.install()` | 自带包装器按 1s 起、退避、60s 内最多 3 次 `[已证]` | 走 Windows 事件日志 `[已证]` | 无（它底层就是打包 WinSW，但没有 `restart!` 入口） | npm 全局包 + daemon 目录 |
| pm2-installer | `npm run setup` | pm2 守护 + `pm2 resurrect` | pm2 日志 + `pm2-logrotate` `[已证]` | `pm2 restart <app>`（但 pm2 自己得先活着） | node-windows 全家桶 |
| 任务计划程序 | `schtasks /sc onstart` | **本身不会**；靠 `/sc minute /mo 1` 看门狗或 XML `RestartOnFailure` 重跑任务 `[部分已证]` | 无；自己 `>> log 2>&1` | `schtasks /end` + `schtasks /run` | 零 |
| 裸 `sc.exe create` | `start= auto` | `sc.exe failure ... actions= restart/60000` | 无 | 不适用 | 零 |
| Docker Desktop | — | 容器 restart policy | docker logs / json-file | `docker restart` | Docker Desktop |

- 为什么**裸 `sc.exe` 对 Node 通常不够**：SCM 要求进程实现服务控制协议（`StartServiceCtrlDispatcher` 等），Node 进程不实现，服务会起不来或立刻报错；即便用 `sc.exe failure` 配了恢复动作，它触发的前提是「服务进程崩溃退出」，而 Node 是正常退出，SCM 视为已停止、不触发恢复。`[推断，机制来自 MSDN 服务生命周期约定]` 所以必须有个包装器（NSSM/WinSW/node-windows）来代持服务身份。
- NSSM 现况：稳定版 2.24 是 **2014-08-31** 的，官网明确说 Win10/Server2016 及更新系统要用 **pre-release 2.24-101**，否则有「服务起不来」的问题 `[已证]` <https://nssm.cc/download>。WinSW 稳定版 v2.12.0 是 2023-01-28，v3 仍是 alpha.11 `[已证]` <https://github.com/winsw/winsw/releases>。
- Docker Desktop 不建议作为本场景交付方式：Desktop 是给 Win10/11 开发机的，Server 上跑容器是另一套（Windows 容器特性），而且 Desktop 本身有商业订阅约束。**我未能取到官方支持矩阵原文（docs.docker.com 抓取失败），这一条按「未验证，不推荐」处理**，不给命令。

## 2. 首选：WinSW v2.12 的完整落地

布局：仓库放 `C:\rw-test`（无空格、无中文），包装器放 `C:\rw-test\svc\`，exe 与 XML **必须同名同目录**（WinSW 找不到同名 XML 会直接报错）`[已证，v2 源码 Program.cs: File.Exists(baseName + ".xml")]`。

`C:\rw-test\svc\rwtest.xml`（元素名均取自官方 XML 文档）

```xml
<service>
  <id>rwtest</id>                                   <!-- 服务名只能用字母数字，别用连字符 -->
  <name>rw-test</name>
  <description>Agent platform (Node.js, port 880)</description>
  <executable>C:\Program Files\nodejs\node.exe</executable>   <!-- 用绝对路径，别靠 PATH -->
  <arguments>server\index.js</arguments>
  <workingdirectory>C:\rw-test</workingdirectory>
  <logpath>C:\rw-test\logs</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15sec</stoptimeout>
  <env name="NODE_ENV" value="production"/>
</service>
```

命令序列（管理员 PowerShell，从「机器已有 Node 和仓库」开始）

```powershell
# 1) 准备目录与包装器（公网直接下）
New-Item -ItemType Directory -Force C:\rw-test\logs, C:\rw-test\svc | Out-Null
Invoke-WebRequest -Uri 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile 'C:\rw-test\svc\rwtest.exe'
# 2) 写入上面那份 rwtest.xml 到 C:\rw-test\svc\rwtest.xml
# 3) 装服务（默认 LocalSystem、自动启动）
C:\rw-test\svc\rwtest.exe install
C:\rw-test\svc\rwtest.exe start
# 4) 放行 880
netsh advfirewall firewall add rule name="rw-test 880" dir=in action=allow protocol=TCP localport=880
C:\rw-test\svc\rwtest.exe status          # 期望 Active (running)
Get-Content C:\rw-test\logs\rwtest.out.log -Tail 50
# 5) 验证开机自启：重启机器后重复上一条 status；验证崩溃拉起：Stop-Process -Name node 再 status
# 6) 卸载
C:\rw-test\svc\rwtest.exe stop; C:\rw-test\svc\rwtest.exe uninstall
```

**要塞进环境变量的自我重启命令（一行字符串）**

```
C:\rw-test\svc\rwtest.exe restart!
```

依据：WinSW v2 源码里 `restart!` 的用途注释就是 “self-restart (can be called from child processes)”，实现是用 `CreateProcess` + `CREATE_NEW_PROCESS_GROUP` 拉起一个**独立进程组**的 `"<exe>" restart` `[已证：v2/src/WinSW/Program.cs]` <https://raw.githubusercontent.com/winsw/winsw/v2/src/WinSW/Program.cs>。等价于 `systemctl restart`，语义见 §5。
账户与安全：WinSW 默认 **LocalSystem**（文档明写「默认 LocalSystem，不需要高权限建议改 LocalService/NetworkService/专用账户」）`[已证]` <https://github.com/winsw/winsw/blob/v2/doc/xmlConfigFile.md>。LocalSystem 是机器上最高权限，若客户要求最小权限，加 `<serviceaccount><domain>.</domain><user>svc_rw</user><password>…</password><allowservicelogon>true</allowservicelogon></serviceaccount>`，代价是该账户要能读 node.exe、读写 `C:\rw-test` 与 `C:\rw-test\logs`、且日志目录别放它自己的 `%TEMP%` 下（§4.3）。

## 3. 备选（客户 IT 不允许第三方二进制）：任务计划程序

零第三方依赖，但需要两个任务：一个开机常驻、一个每分钟看门狗。PowerShell 建任务并导出 XML 最稳（`schtasks /create /xml` 官方支持）`[已证]` <https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create>：

```powershell
$wd = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' -Argument 'server\index.js' -WorkingDirectory 'C:\rw-test'
$on = New-ScheduledTaskTrigger -AtStartup
$every = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'rw-test' -Action $wd -Trigger $on,$every -User 'SYSTEM' -RunLevel Highest -Force
Export-ScheduledTask -TaskName 'rw-test' | Set-Content C:\rw-test\svc\rw-test-task.xml   # 作为交付物留存
```

- 自启/拉起：`-AtStartup` 负责开机；**崩溃拉起靠每分钟那次重复触发**（Node 已死则重启，还活着则新实例因 880 端口被占而立即退出，不影响在跑的进程）`[推断]`。纯 `schtasks` 命令行版：`schtasks /create /tn rw-test /tr "C:\Program Files\nodejs\node.exe server\index.js" /sc onstart /ru SYSTEM /rl HIGHEST /f` `[已证，参数表]`；但它没法像 XML 那样精细控制重复间隔与「已在运行时忽略」策略，建议用上面 PowerShell 版。
- 日志：靠 Node 自己写文件，或把 `/tr` 换成 `cmd /c "... >> C:\rw-test\logs\out.log 2>&1"` `[推断]`。
- 自我重启（一行字符串，入环境变量）：`schtasks /end /tn rw-test & schtasks /run /tn rw-test`。`/run` 是「立即启动任务，用任务里保存的程序与账户」，不改变任务计划 `[已证]` <https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-run>；它由任务计划服务启动一个**与原进程无关的新进程**，所以原进程死去不影响它 `[推断，机制：任务由 Scheduler 服务启动]`。
- 额外好处：任务侧还有「失败后按间隔重启任务」的独立恢复动作，可作为第二层保险 `[部分已证，见 learn.microsoft.com 任务计划 XML 架构 RestartOnFailure]`。

## 4. 已知的坑

1. **路径带空格/中文**：XML 用绝对路径、`<workingdirectory>` 显式给；`schtasks /tr` 里带空格的可执行文件要连引号一起转义，最省事的做法是把 `node.exe` 与仓库都放在无空格无中文的路径（`C:\rw-test`）。NSSM 官网专门有一节 “Quoting issues” 说明空格必须加引号、内含空格参数要多层引号 `[已证]` <https://nssm.cc/usage>。
2. **nvm-windows ≠ 服务账户**：nvm 切换版本靠替换 `C:\Program Files\nodejs` 目录/符号链接，服务里写死 node.exe 绝对路径后，切版本可能让服务指向失效目标而拒绝启动 `[推断]`；pm2-installer 明确声明「不支持 nvm for windows，必须标准安装」`[已证]` <https://github.com/jessety/pm2-installer>。做法：服务只绑标准安装的 node 绝对路径，升级 Node 走「装新版本 → 改 XML → `rwtest.exe refresh` → restart」。
3. **服务账户的 `%TEMP%` 会被清**：Win Server 2019/2022（带桌面体验）上，登录会话超过 7 天时 **SilentCleanup（cleanmgr.exe）会删掉带会话 ID 的 `%TEMP%`**；Storage Sense 开启或 C 盘吃紧时也会删，这是 by design `[已证，微软支持文档 KB4506040]` <https://learn.microsoft.com/en-us/troubleshoot/windows-server/shell-experience/temp-folder-with-logon-session-id-deleted>。规避：日志、上传临时文件、`git` 的临时目录一律指向业务目录（如 `C:\rw-test\logs`、`C:\rw-test\tmp`），别用 `os.tmpdir()` 当持久位置。
4. **`sc.exe` 错误码**：`1060`=服务不存在（没装或名字写错）；`1062`=服务未启动（对已停止的服务执行 start/stop 时常见）；`1053`=服务没有及时响应启动/控制请求（典型是 binPath 直接指向 node.exe、或包装器路径写错）；`5`=拒绝访问（未用管理员终端）。`[已证，均为 Win32 服务错误码；未逐条核对 learn.microsoft.com 的 System Error Codes 页面]`
5. **服务权限**：装/改/删服务都要管理员终端，普通用户执行会 `拒绝访问`（WinSW 会自己弹 UAC 提权，服务模式下则不会）`[已证，源码 Elevate()]`；`%ProgramFiles%` 下的文件不能让普通用户可写，否则是本地提权面。WinSW 卸载后会在事件日志留下 Application 源的注册信息 `[已证，源码 CreateEventSource]`。
6. **防火墙 880**：Windows 默认无 iptables，必须显式放行；命令见 §2（`dir=in action=allow protocol=TCP localport=880`）`[已证]`。
7. **`git pull` 撞文件锁**：正在运行的 Node 进程会占用被加载的文件（原生 `.node`、脚本），Windows 上不是「可以随意覆盖」的语义，会出现 `EPERM/EBUSY` 类失败 `[推断，多起社区报告；未找到官方规范原文]`。规避顺序：先 `rwtest.exe stop` → `git pull` → 若 `package.json` 变了再 `npm ci` → `rwtest.exe start`；或把「拉代码」做成先拉再 restart，并把 `npm ci` 放在停服务期间。不要指望「一边 pull 一边跑」在生产上稳定。
8. **别把仓库和包装器塞同一目录**：`git pull` 会顺带处理 `svc/` 下的 exe/XML；分开放（`C:\rw-test\svc` 不入库）最干净。`[推断]`

## 5. 与 Linux/systemd 的语义对齐，以及「会自杀但拉不起来」的坑

**等价性**：`rwtest.exe restart!` ≈ `systemctl restart rw-test`。它先让服务停止、等 SCM 确认 Stopped，再 Start 并等 Running `[已证，v2 源码 Restart()]`；而且它是在**独立进程组**里执行，所以「自己重启自己」不会因为父进程被杀而中断 —— 这正是 systemd 下 `systemctl restart` 由 PID 1 执行所天然具备的性质。**注意**：WinSW 的 `restart!` 只在 Elevated（服务身份即 LocalSystem/服务 SID）下可用，非提权调用会直接返回 access denied `[已证，源码]`。

**会自杀且不拉起来的做法（重要）**：

- `sc.exe stop rw-test`（或 `net stop`）**任何包装器方案下都会把自己停死**——NSSM 收到 SCM 的停止请求后会优雅结束被管进程然后退出，恢复动作只在「进程异常退出」时才触发；手动 stop 是「正常停止」，SCM 的 `failure` 动作不会介入。所以**绝不能**把自我重启写成 `sc stop` 再指望谁来 `sc start`。`[推断，机制明确；NSSM 官网 “Customising the action taken when a service fails” 一节说明了 SCM 恢复动作的前提]` <https://nssm.cc/scenarios>
- `nssm stop rw-test` 同理：即使配置了 `AppExit Default Restart`，由 SCM/命令行发起的停止是「意图停止」，包装器不会再把应用拉起来。若改成 `nssm restart rw-test`，它是「停服务再起服务」，可以从子进程调用（子进程被终止也无所谓，命令已被 nssm.exe 接收）`[推断]`；但 nssm.exe 并未提供像 WinSW `restart!` 那样「明确为子进程自我重启而设计」的入口，因此不作为首选。
- Path 直接指向 `node.exe` 的裸服务：`sc stop` 要么等超时（1053），要么停止后无人拉起；`sc start` 又会因为进程不是合格的服务宿主而失败。
- 任务计划方案下，**只用 `schtasks /end` 也是自杀**：必须 `/end` 紧跟 `/run`（或干脆让看门狗下一分钟拉起）。

## 6. 查不到 / 未验证的部分

- Docker Desktop 是否官方支持把 Windows Server 作为宿主：未找到明确的支持矩阵原文，故只作「不推荐」处理，未给命令。任务计划 XML 的 `RestartOnFailure` 精确行为与 Node 退出码的配合：未找到等价于 SCM `sc failure` 的完整官方说明，仅作第二层保险提及。
- WinSW v3 目前仍是 alpha（v3.0.0-alpha.11，2023-01），本报告一律以 **v2.12.0** 为准；v3 的新 CLI 同样保留 `restart!`（已在 v3 源码中确认），但其文档页未列出，属于文档遗漏 `[已证：v3/src/WinSW/Program.cs]`。

---
本文只做调研，未改任何代码。
