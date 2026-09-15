<#
.SYNOPSIS
  Roni Workbench · Windows Server 安装脚本（WinSW v2.12.0 托管为 Windows 服务）

.DESCRIPTION
  幂等安装：前置检查 → 取并校验 WinSW → 生成 <WrapperName>.xml → 装/刷新服务 → 启动 →
  放行防火墙端口 → 跑 scripts/selfcheck.mjs 并原样打印结果。
  再跑一次不会重复装（服务已存在则改为 refresh，把 XML 的改动推给 SCM）。

  WinSW 版本、下载 URL、文件大小、CLI 命令名均核对自官方来源：
    - 发布页      https://github.com/winsw/winsw/releases/tag/v2.12.0
    - XML 规格    https://github.com/winsw/winsw/blob/v2/doc/xmlConfigFile.md
    - 日志与轮转  https://github.com/winsw/winsw/blob/v2/doc/loggingAndErrorReporting.md
    - 自我重启    https://github.com/winsw/winsw/blob/v2/doc/selfRestartingService.md
    - CLI 与退出码 https://github.com/winsw/winsw/blob/v2/src/WinSW/Program.cs
  环境变量口径（唯一事实源）：server/env.js —— 本脚本不复制它的默认值，只把确定的值写进服务 XML。
  运行手册与故障排查：scripts/windows/DEPLOY-Windows.md

.NOTES
  要求 Windows PowerShell 5.1（Windows Server 自带）、管理员权限。
  本脚本不会下载除 WinSW 官方 release 之外的任何东西，也不删除任何业务数据。
#>
[CmdletBinding()]
param(
  # 平台代码目录（含 server\index.js 与 package.json）。不给则按本脚本位置推导 scripts\windows\ -> 平台根。
  [string]$PlatformDir,
  # Agent 工作区。默认＝平台目录的兄弟目录 rw-workspace（与 server/env.js 的推导口径一致）。
  [string]$Workspace,
  # 包装器目录：rwtest.exe / rwtest.xml / logs 都放这里。刻意与平台目录分开，git pull 不会碰到它。
  [string]$ServiceDir,
  # 服务监听端口（写入防火墙规则用；实际监听端口来自平台 .env 的 PORT，脚本会核对两者）。
  [int]$Port = 880,
  # 平台内部的服务名＝RW_SERVICE（env.js / restart.js 用它），也是 Windows 服务显示名。
  [string]$ServiceName = 'rw-test',
  # WinSW 包装器文件名（不含 .exe）。必须纯字母数字：WinSW 的服务 <id> 只能用字母数字。
  [string]$WrapperName = 'rwtest',
  # 后台任务日志目录＝RW_JOBS_DIR。必须落在持久盘，不能用 %TEMP%（KB4506040 会被清）。
  [string]$JobsDir,
  # node.exe 全路径。默认从 PATH 里找 node，再退回标准安装位置。不要用 nvm-windows 的软链。
  [string]$NodeExe,
  # 显式指定平台自我重启命令＝RW_RESTART_CMD。默认＝"<ServiceDir>\<WrapperName>.exe" restart!
  [string]$RestartCmd,
  # 自检用管理员账号/密码。默认从平台 .env 的 RW_ADMIN_USER / RW_ADMIN_PASS 读。
  [string]$AdminUser,
  [string]$AdminPass,
  [string]$WinSwUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe",
  # 官方 release 未发布校验和；用发布页上的字节数做完整性核对（改 WinSW 版本时必须同步改这两个）。
  [long]$WinSwSize = 18243033,
  [switch]$SkipDownload,     # 跳过下载，用 ServiceDir 里已有的同名 exe
  [switch]$SkipBuild,        # 跳过 npm ci / npm run build
  [switch]$SkipFirewall,     # 不碰防火墙
  [switch]$SkipSelfCheck,    # 不跑自检
  [switch]$WhatIfOnly        # 只做检查与打印，不下载、不写文件、不装服务、不改防火墙
)

$ErrorActionPreference = 'Stop'
# 未被赋值的变量（如路径解析前就失败）也要能安全拼进报错信息
Set-StrictMode -Version 2.0
$script:Step = '启动'
$script:InstalledNow = $false
$script:StartedNow = $false
$script:FirewallAdded = $false
$script:RuleName = "$ServiceName $Port"
$script:WrapperExe = $null
$script:XmlPath = $null
$script:EnvMap = @{}
$LogDir = $null

# WinSW 官方 CLI 命令名（Program.cs 的 switch：install/uninstall/refresh/start/stop/restart/restart!/status/...）
$CMD_INSTALL = 'install'
$CMD_REFRESH = 'refresh'   # 重读 XML 并把配置变更推给 SCM（install 对已存在的服务会以 1073 失败）
$CMD_START = 'start'
$CMD_STOP = 'stop'
$CMD_STATUS = 'status'
$CMD_UNINSTALL = 'uninstall'

function Write-Section([string]$Text) { Write-Host ''; Write-Host "=== $Text ===" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Write-Info([string]$Text) { Write-Host "  [ ]    $Text" }

# 失败必须明确报错并说清怎么回退；绝不静默继续。
function Fail([string]$Message, [string]$HowToRollback) {
  Write-Host ''
  Write-Host "安装失败（步骤：$script:Step）" -ForegroundColor Red
  Write-Host "  原因：$Message" -ForegroundColor Red
  if ($HowToRollback) { Write-Host "  回退：$HowToRollback" -ForegroundColor Yellow }
  if ($script:FirewallAdded) {
    Write-Host "  本次已添加的防火墙规则需要清理：" -ForegroundColor Yellow
    Write-Host "    netsh advfirewall firewall delete rule name=`"$script:RuleName`"" -ForegroundColor Yellow
  }
  if ($script:StartedNow -or $script:InstalledNow) {
    Write-Host "  本次已注册的服务可这样卸掉（不会删任何数据）：" -ForegroundColor Yellow
    Write-Host "    & `"$script:WrapperExe`" $CMD_STOP" -ForegroundColor Yellow
    Write-Host "    & `"$script:WrapperExe`" $CMD_UNINSTALL" -ForegroundColor Yellow
    Write-Host "  或直接跑：scripts\windows\uninstall-service.ps1 -ServiceDir `"$ServiceDir`"" -ForegroundColor Yellow
  }
  exit 1
}

# 跑一个原生命令并回传退出码 + 输出行（不抛异常，由调用方决定怎么处理退出码）
function Invoke-Native([string]$Exe, [string[]]$ArgList) {
  $out = & $Exe @ArgList 2>&1 | ForEach-Object { "$_" }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = @($out) }
}

# 带重试的 WinSW CLI 调用：解决"服务刚 register/start 完，SCM 状态还没落定"的竞态
function Invoke-WinSw([string]$Command, [int]$Retry = 5, [int]$DelaySec = 2) {
  $last = $null
  for ($i = 0; $i -lt $Retry; $i++) {
    $last = Invoke-Native $script:WrapperExe @($Command)
    if ($last.Code -eq 0) { return $last }
    Start-Sleep -Seconds $DelaySec
  }
  return $last
}

function Test-AlphaNumeric([string]$Text) { return ($Text -match '^[A-Za-z0-9]+$') }

# WinSW 配置值放在 XML 元素/属性里，必须转义，否则 & < > 会破坏 XML
function ConvertTo-XmlText([string]$Text) {
  return ([string]$Text).Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')
}
function ConvertTo-XmlAttr([string]$Text) {
  return (ConvertTo-XmlText $Text).Replace('"', '&quot;')
}

# 读平台 .env（server/config.js 的同款口径：# 注释、KEY=VALUE、值两端引号可选）
function Read-DotEnv([string]$Path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    $t = "$line".Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $m = [regex]::Match($t, '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
    if ($m.Success) {
      $v = $m.Groups[2].Value.Trim()
      if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
        $v = $v.Substring(1, $v.Length - 2)
      }
      $map[$m.Groups[1].Value] = $v
    }
  }
  return $map
}

# 按 WinSW v2 XML 规格生成配置（元素名逐个对照 doc/xmlConfigFile.md）
function Build-ServiceXml() {
  $qw = ConvertTo-XmlText $script:WrapperExe
  $l = New-Object System.Collections.Generic.List[string]
  $l.Add('<service>')
  $l.Add("  <id>$WrapperName</id>")   # 只能用字母数字，且全机器唯一
  $l.Add("  <name>$(ConvertTo-XmlText $ServiceName)</name>")
  $l.Add("  <description>$(ConvertTo-XmlText $Script:Description)</description>")
  $l.Add('  <startmode>Automatic</startmode>')
  $l.Add("  <executable>$(ConvertTo-XmlText $NodeExe)</executable>")
  $l.Add('  <arguments>server\index.js</arguments>')
  $l.Add("  <workingdirectory>$(ConvertTo-XmlText $PlatformDir)</workingdirectory>")
  $l.Add('  <stoptimeout>15sec</stoptimeout>')
  $l.Add("  <logpath>$(ConvertTo-XmlText $LogDir)</logpath>")
  # 轮转：单文件 10MB、留 8 个（sizeThreshold 单位 KB；官方文档 loggingAndErrorReporting.md）
  $l.Add('  <log mode="roll-by-size">')
  $l.Add('    <sizeThreshold>10240</sizeThreshold>')
  $l.Add('    <keepFiles>8</keepFiles>')
  $l.Add('  </log>')
  # 崩溃拉起：进程以非零码退出时由 SCM 在 10 秒后重启；连续稳定运行 1 小时则清零失败计数
  $l.Add('  <onfailure action="restart" delay="10 sec"/>')
  $l.Add('  <resetfailure>1 hour</resetfailure>')
  foreach ($e in $script:ServiceEnv) {
    $l.Add("  <env name=`"$(ConvertTo-XmlAttr $e.Name)`" value=`"$(ConvertTo-XmlAttr $e.Value)`"/>")
  }
  $l.Add('</service>')
  return ($l -join "`r`n") + "`r`n"
}

function Invoke-FirewallStep() {
  $existing = Invoke-Native 'netsh' @('advfirewall', 'firewall', 'show', 'rule', "name=$script:RuleName")
  if ("$($existing.Out -join ' ')" -match 'No rules match') {
    if ($WhatIfOnly) { Write-Info "WhatIf：会执行 netsh advfirewall firewall add rule name=`"$script:RuleName`" dir=in action=allow protocol=TCP localport=$Port"; return }
    $add = Invoke-Native 'netsh' @('advfirewall', 'firewall', 'add', 'rule', "name=$script:RuleName", 'dir=in', 'action=allow', 'protocol=TCP', "localport=$Port")
    if ($add.Code -ne 0) {
      Fail "netsh 添加防火墙规则失败（退出码 $($add.Code)）：$($add.Out -join ' / ')" `
        '手动放行：netsh advfirewall firewall add rule name="' + $script:RuleName + '" dir=in action=allow protocol=TCP localport=' + $Port
    }
    $script:FirewallAdded = $true
    Write-Ok "已放行入站 TCP $Port（规则名：$script:RuleName）"
  }
  else {
    Write-Ok "防火墙规则已存在，跳过：$script:RuleName"
  }
  # 同端口若已有别的放行规则，给出提示而不是再加一条（netsh 的 show 输出是固定列宽）
  $all = Invoke-Native 'netsh' @('advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in')
  if (@($all.Out | Select-String -SimpleMatch "LocalPort:" | Select-String -SimpleMatch "$Port").Count -gt 0) {
    Write-Info "已存在同端口的入站规则（netsh advfirewall firewall show rule name=all dir=in 可查），本脚本不重复添加。"
  }
}

function Invoke-SelfCheck() {
  $base = "http://127.0.0.1:$Port"
  $u = $AdminUser
  $p = $AdminPass
  if (-not $u) { $u = $script:EnvMap['RW_ADMIN_USER'] }
  if (-not $p) { $p = $script:EnvMap['RW_ADMIN_PASS'] }
  if (-not $u -or -not $p) {
    Write-Warn2 '自检跳过：缺管理员账号。传 -AdminUser / -AdminPass，或在平台 .env 里设 RW_ADMIN_USER / RW_ADMIN_PASS。'
    return
  }
  if ($WhatIfOnly) { Write-Info "WhatIf：会执行 & `"$NodeExe`" `"$SelfCheck`" $base $u <password>"; return }
  Write-Info "执行自检：& `"$NodeExe`" `"$SelfCheck`" $base $u <password>"
  $r = Invoke-Native $NodeExe @($SelfCheck, $base, $u, $p)
  Write-Host ''
  foreach ($line in $r.Out) { Write-Host "  $line" }   # 原样打印，不改写结论
  Write-Host ''
  if ($r.Code -eq 0) { Write-Ok '自检全部通过。' }
  else {
    Write-Warn2 "自检未全部通过（退出码 $($r.Code)）。这不影响服务已在运行，但要按上表定位："
    Write-Warn2 "  连不上服务   → 看 $LogDir\*.err.log 与服务状态"
    Write-Warn2 "  登录失败     → 平台 .env 的 RW_ADMIN_USER / RW_ADMIN_PASS"
    Write-Warn2 "  基础 API 500 → 远端 MySQL 连通性与 .env 的 DB_* 配置"
    Write-Warn2 "  对话无输出   → .env 里的模型 API Key 与客户机出网策略"
  }
}

# ============================ 主流程 ============================

Write-Host ''
Write-Host 'Roni Workbench · Windows Server 安装（WinSW v2.12.0 托管）' -ForegroundColor White
if ($WhatIfOnly) { Write-Host '模式：-WhatIfOnly（只检查、不落地）' -ForegroundColor Yellow }

$script:Step = '前置检查'

# 0) 管理员权限（装/改/删服务都要管理员终端）
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail '当前不是管理员终端。' '右键 PowerShell →「以管理员身份运行」，再执行本脚本。'
}
Write-Ok "管理员权限：$($identity.Name)"

# 1) 补默认路径（默认值里引用别的参数，故在此处解析）
if (-not $PlatformDir) {
  # 本脚本位于 <平台>\scripts\windows\ 下，向上两级即平台目录；找不到就要求显式传 -PlatformDir
  $cand = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  if (Test-Path -LiteralPath (Join-Path $cand 'server\index.js')) { $PlatformDir = $cand }
  else { Fail '无法推导平台目录（本脚本不在 <平台>\scripts\windows\ 下）。' '显式传：-PlatformDir "D:\rw-test"' }
}
$PlatformDir = (Resolve-Path -LiteralPath $PlatformDir).Path   # 归一化成绝对路径，避免 XML 里出现相对路径
if (-not $Workspace) { $Workspace = Join-Path (Split-Path -Parent $PlatformDir) 'rw-workspace' }
if (-not $JobsDir) { $JobsDir = Join-Path $PlatformDir 'logs\jobs' }
if (-not $ServiceDir) { $ServiceDir = Join-Path $PlatformDir 'svc' }
if (-not $LogDir) { $LogDir = Join-Path $ServiceDir 'logs' }
$script:WrapperExe = Join-Path $ServiceDir "$WrapperName.exe"
$script:XmlPath = Join-Path $ServiceDir "$WrapperName.xml"
$script:Description = "Roni Workbench · Agent 平台（Node.js，端口 $Port）"
$script:ServiceEnv = @()

Write-Info "平台目录   ：$PlatformDir"
Write-Info "Agent 工作区：$Workspace"
Write-Info "包装器目录 ：$ServiceDir"
Write-Info "服务日志   ：$LogDir"
Write-Info "后台任务日志：$JobsDir"
Write-Info "服务名     ：$ServiceName（服务 ID：$WrapperName）"
Write-Info "监听端口   ：$Port"

# 2) 名字合法性：WinSW 的 <id> 只能用字母数字（doc/xmlConfigFile.md）
if (-not (Test-AlphaNumeric $WrapperName)) {
  Fail "-WrapperName `"$WrapperName`" 含非字母数字字符。WinSW 的服务 ID 只能用字母数字（例：rwtest）。" `
    '-WrapperName rwtest'
}

# 3) 端口值域
if ($Port -lt 1 -or $Port -gt 65535) { Fail "-Port $Port 不在 1..65535 范围内。" '改用平台 .env 里 PORT 的值。' }

# 4) 仓库路径检查
$entry = Join-Path $PlatformDir 'server\index.js'
$pkg = Join-Path $PlatformDir 'package.json'
if (-not (Test-Path -LiteralPath $entry)) { Fail "平台上没有入口文件：$entry" "把代码放到 $PlatformDir，或用 -PlatformDir 指向真实平台目录。" }
if (-not (Test-Path -LiteralPath $pkg)) { Fail "平台上没有 package.json：$pkg" "把代码放到 $PlatformDir，或用 -PlatformDir 指向真实平台目录。" }
$selfCheck = Join-Path $PlatformDir 'scripts\selfcheck.mjs'
if (-not $SkipSelfCheck -and -not (Test-Path -LiteralPath $selfCheck)) { Write-Warn2 "自检脚本不存在：$selfCheck（稍后会跳过自检）" }
Write-Ok "平台入口与 package.json 就位：$PlatformDir"
# XML 里写的是 `server\index.js` 这种相对参数，工作目录必须能对上
if (-not (Test-Path -LiteralPath (Join-Path $PlatformDir 'server'))) { Fail "$PlatformDir 下没有 server 目录。" '检查平台目录是否完整（git clone 是否成功）。' }

# 5) node / npm / git
if (-not $NodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodeExe = $cmd.Source }
  elseif (Test-Path -LiteralPath "$env:ProgramFiles\nodejs\node.exe") { $NodeExe = "$env:ProgramFiles\nodejs\node.exe" }
}
if (-not $NodeExe) {
  Fail '找不到 node.exe（PATH 与 %ProgramFiles%\nodejs 都没有）。' `
    '装 Node.js LTS 官方安装包（https://nodejs.org/en/download ，选 Windows Installer .msi），然后重开管理员终端。'
}
if (-not (Test-Path -LiteralPath $NodeExe)) { Fail "node.exe 不存在：$NodeExe" '用 -NodeExe 指向真实 node.exe，或重装 Node.js。' }
$nodeVerRaw = (& $NodeExe -v).Trim()          # 形如 v22.23.2
$nodeVer = ($nodeVerRaw -replace '^v', '')
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 18) { Fail "Node.js 版本过低：$nodeVerRaw（平台要求 >=18，package.json engines）。" '升级到当前 LTS（https://nodejs.org/en/download ），再重跑本脚本。' }
Write-Ok "Node.js $nodeVerRaw（$NodeExe）"

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCmd) {
  Fail 'PATH 里找不到 npm。' '重开管理员终端；若仍没有，重装 Node.js（npm 随 Node 一起装）。'
}
Write-Ok "npm：$($npmCmd.Source)"

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) { Write-Warn2 'PATH 里没有 git：本次安装不依赖它，但 upgrade.ps1 / 平台自身的发版能力需要。' }
else { Write-Ok "git：$($gitCmd.Source)" }

# 6) 与服务账户的错配检查（服务将以 LocalSystem 运行，见 DEPLOY-Windows.md 的「服务账户权限」）
if ($NodeExe -match '\\AppData\\') {
  Write-Warn2 "node.exe 在用户目录下（$NodeExe）：服务账户读不到它。请用标准安装的 Node.js，不要用 nvm-windows / npx 装的临时版本。"
}

# 7) .env 与端口一致性
$script:EnvMap = Read-DotEnv (Join-Path $PlatformDir '.env')
$envPort = $script:EnvMap['PORT']
if (-not $envPort) {
  Write-Warn2 "平台 .env 里没有 PORT，平台会退回 config.js 的默认 3000，与 -Port $Port 不一致。"
  $envPort = '3000(默认)'
}
elseif ([int]$envPort -ne $Port) {
  Fail ".env 的 PORT=$envPort 与 -Port $Port 不一致：防火墙会放行错端口。" `
    "改平台 .env 的 PORT=$Port，或改成 -Port $envPort 后重跑。"
}
else { Write-Ok ".env 的 PORT=$envPort 与 -Port 一致" }

$dbHost = $script:EnvMap['DB_HOST']
if (-not $dbHost) { Write-Warn2 '.env 里没有 DB_HOST：平台会退回 127.0.0.1，而数据库在远端，登录/接口会失败。' }
else {
  if ($dbHost -eq '127.0.0.1' -or $dbHost -eq 'localhost') {
    Write-Warn2 "DB_HOST=$dbHost 指向本机，但本部署的数据库在远端。确认这是客户机的真实数据库地址。"
  }
  Write-Ok "远端数据库：$dbHost`:$($script:EnvMap['DB_PORT']) / $($script:EnvMap['DB_NAME'])"
}
if (-not $script:EnvMap['RW_ADMIN_PASS'] -and -not $AdminPass) { Write-Warn2 '.env 里没设 RW_ADMIN_PASS：安装末尾的自检会因缺账号跳过。' }

# 8) 环境事实核对：平台自己推导出的 RW_WORKSPACE / RW_JOBS_DIR 必须与写进 XML 的一致
#    （env.js 是唯一事实源，这里跑一遍它，避免"XML 写一个、代码算另一个"）
$envFile = Join-Path $PlatformDir 'server\env.js'
if (Test-Path -LiteralPath $envFile) {
  # 探针只读 env.js 推导出的值（不传任何 RW_* 环境变量），用来核对"默认推导"与将被写进 XML 的值。
  # 路径经 base64 传进 JS，避免在 JS 字面量里嵌 Windows 反斜杠与引号；file:/// 前缀在 PowerShell 里拼好。
  $envUrl = 'file:///' + ($envFile -replace '\\', '/')
  $env:PROBE_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($envUrl))
  $probe = "const m = await import(Buffer.from(process.env.PROBE_B64, 'base64').toString()); console.log(JSON.stringify({ platform: m.RW_PLATFORM_DIR, workspace: m.RW_WORKSPACE, jobs: m.RW_JOBS_DIR }))"
  $probeOut = & $NodeExe '--input-type=module' '-e' $probe 2>&1
  Remove-Item Env:\PROBE_B64 -ErrorAction SilentlyContinue
  $parsed = $null
  try { $parsed = ("$($probeOut | Out-String)").Trim() | ConvertFrom-Json } catch { $parsed = $null }
  if ($parsed) {
    Write-Info "env.js 推导：platform=$($parsed.platform) workspace=$($parsed.workspace) jobs=$($parsed.jobs)"
    if ("$($parsed.workspace)" -ine $Workspace) { Write-Warn2 "env.js 推导的 RW_WORKSPACE（$($parsed.workspace)）与 -Workspace（$Workspace）不同；服务 XML 会把 RW_WORKSPACE 固定成后者。" }
    if ("$($parsed.jobs)" -ine $JobsDir) { Write-Warn2 "env.js 默认 RW_JOBS_DIR（$($parsed.jobs)）在 %TEMP% 下（会被系统清理）；服务 XML 会覆盖成 $JobsDir。" }
  }
  else { Write-Warn2 "env.js 探针未返回可解析结果，跳过这项核对：$($probeOut -join ' / ')" }
}
else { Write-Warn2 "找不到 server\env.js，跳过环境事实核对。" }

# 9) 目录准备（日志与后台任务目录必须落在业务盘持久位置）
foreach ($d in @($Workspace, $ServiceDir, $LogDir, $JobsDir)) {
  if ($WhatIfOnly) { Write-Info "WhatIf：会创建目录 $d"; continue }
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null; Write-Ok "已创建目录：$d" }
  else { Write-Info "目录已存在：$d" }
}

# 10) 端口占用（本机监听端口被别的进程占了，服务起不来）
$script:Step = '端口检查'
$listeners = @()
try { $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop) } catch { $listeners = @() }
if ($listeners.Count -gt 0) {
  $svcOnPort = (Get-Service -Name $WrapperName -ErrorAction SilentlyContinue)
  $owners = @()
  foreach ($l in $listeners) {
    $p = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
    $owners += "$($l.LocalAddress):$Port -> PID $($l.OwningProcess) $(if ($p) { $p.ProcessName } else { '?' })"
  }
  if ($svcOnPort -and $svcOnPort.Status -eq 'Running') {
    Write-Warn2 "端口 $Port 已在监听，且服务 $ServiceName 正在运行——按幂等重装继续（安装流程会先停服务再起）。"
  }
  else {
    Fail "端口 $Port 已被占用：$($owners -join '；')" `
      '找到占用者：Get-NetTCPConnection -State Listen -LocalPort ' + $Port + ' | Select-Object OwningProcess；停掉它或换端口（换端口要同步改平台 .env 的 PORT）。'
  }
}
else { Write-Ok "端口 $Port 当前空闲" }

# 11) 依赖与前端构建（幂等：已装过就不重装，省客户机时间与出网依赖）
$script:Step = '依赖与前端构建（npm ci / npm run build）'
if ($SkipBuild) { Write-Warn2 '按 -SkipBuild 跳过 npm ci / npm run build。' }
else {
  $nodeModules = Join-Path $PlatformDir 'node_modules'
  $distDir = Join-Path $PlatformDir 'web\dist'
  $needCi = -not (Test-Path -LiteralPath $nodeModules)
  $needBuild = $needCi -or (-not (Test-Path -LiteralPath (Join-Path $distDir 'index.html')))
  if ($WhatIfOnly) {
    Write-Info "WhatIf：npm ci 需要＝$needCi；npm run build 需要＝$needBuild"
  }
  elseif (-not $needCi -and -not $needBuild) {
    Write-Ok "node_modules 与前端产物都在，跳过 npm ci / npm run build"
  }
  else {
    Push-Location $PlatformDir
    try {
      if ($needCi) {
        $ci = Invoke-Native $npmCmd.Source @('ci')
        if ($ci.Code -ne 0) {
          Fail "npm ci 失败（退出码 $($ci.Code)）：$($ci.Out | Select-Object -Last 15 | Out-String)" `
            "在 $PlatformDir 手动跑 npm ci 看完整报错；常见原因是客户机出网被拦（防火墙/代理白名单要放行 registry.npmjs.org）。"
        }
        Write-Ok 'npm ci 完成'
      }
      else { Write-Info 'node_modules 已存在，跳过 npm ci' }
      if ($needBuild) {
        $b = Invoke-Native $npmCmd.Source @('run', 'build')
        if ($b.Code -ne 0) {
          Fail "npm run build 失败（退出码 $($b.Code)）：$($b.Out | Select-Object -Last 15 | Out-String)" `
            "在 $PlatformDir 手动跑 npm run build 看完整报错。前端产物缺失时页面打不开，但 API 仍可用。"
        }
      }
      if (Test-Path -LiteralPath (Join-Path $distDir 'index.html')) { Write-Ok "前端产物就位：$distDir" }
      else { Write-Warn2 "前端产物未见 index.html（$distDir）：页面可能打不开，接口不受影响。" }
    }
    finally { Pop-Location }
  }
}

# 12) WinSW 包装器：下载 + 校验
$script:Step = '获取并校验 WinSW'
$needDownload = $true
if ($WhatIfOnly) {
  Write-Info "WhatIf：会从 $WinSwUrl 取 WinSW 到 $script:WrapperExe"
  $needDownload = $false
}
elseif (Test-Path -LiteralPath $script:WrapperExe) {
  $size = (Get-Item -LiteralPath $script:WrapperExe).Length
  if ($SkipDownload) { Write-Warn2 "按 -SkipDownload 使用已有包装器（$size 字节），跳过下载与大小核对：$script:WrapperExe"; $needDownload = $false }
  elseif ($size -eq $WinSwSize) { Write-Ok "WinSW 已就位且大小匹配官方发布页（$size 字节），跳过下载"; $needDownload = $false }
  else { Write-Warn2 "已有包装器大小 $size 与官方 $WinSwSize 不符，重新下载" }
}

if (-not $WhatIfOnly -and $needDownload) {
  # PS 5.1 的 .NET 默认可能不协商 TLS 1.2，GitHub 会直接断连
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  $tmp = Join-Path $env:TEMP "$WrapperName.download.exe"
  Write-Info "下载 $WinSwUrl"
  try {
    Invoke-WebRequest -Uri $WinSwUrl -OutFile $tmp -UseBasicParsing -TimeoutSec 300
  }
  catch {
    Fail "下载 WinSW 失败：$($_.Exception.Message)" `
      "确认客户机能出网到 github.com / objects.githubusercontent.com，或手动把 WinSW-x64.exe 拷到 $ServiceDir 并改名为 $WrapperName.exe，再用 -SkipDownload 重跑。"
  }
  $dlSize = (Get-Item -LiteralPath $tmp).Length
  if ($dlSize -ne $WinSwSize) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Fail "下载到的文件大小 $dlSize 与官方发布页的 $WinSwSize 不一致（可能被代理替换或下载中断）。" `
      "删掉 $ServiceDir 下的包装器重下；公司代理会改写二进制时，改用手工拷贝 + -SkipDownload。"
  }
  # PE 头校验：MZ 开头，避免把 HTML 错误页当可执行文件
  $fs = [System.IO.File]::OpenRead($tmp)
  try {
    $b0 = $fs.ReadByte(); $b1 = $fs.ReadByte()
    if ($b0 -ne 0x4D -or $b1 -ne 0x5A) { Fail '下载到的文件不是 PE 可执行文件（没有 MZ 头）。' '删掉后重下；若是代理拦截，改用手工拷贝 + -SkipDownload。' }
  }
  finally { $fs.Dispose() }
  Move-Item -LiteralPath $tmp -Destination $script:WrapperExe -Force
  Write-Ok "WinSW 就位：$script:WrapperExe（$WinSwSize 字节，MZ 头校验通过；官方 release 未发布校验和，故用大小+PE 头核对）"
}

# 13) 生成 rwtest.xml
$script:Step = '生成服务配置 XML'
$restartArg = "$script:WrapperExe" + ' restart!'
if (-not $RestartCmd) { $RestartCmd = $restartArg }
$script:ServiceEnv = @(
  @{ Name = 'RW_PLATFORM_DIR'; Value = $PlatformDir }
  @{ Name = 'RW_WORKSPACE'; Value = $Workspace }
  @{ Name = 'RW_JOBS_DIR'; Value = $JobsDir }
  @{ Name = 'RW_SERVICE'; Value = $ServiceName }
  @{ Name = 'RW_RESTART_CMD'; Value = $RestartCmd }
  @{ Name = 'NODE_ENV'; Value = 'production' }
)
$xmlText = Build-ServiceXml
if ($WhatIfOnly) {
  Write-Info "WhatIf：会写入 $script:XmlPath，内容如下"
  Write-Host $xmlText
}
else {
  Set-Content -LiteralPath $script:XmlPath -Value $xmlText -Encoding UTF8
  # XML 必须能被解析（元素名写错在这里就会暴露）
  try { [xml]$null = Get-Content -LiteralPath $script:XmlPath -Raw } catch { Fail "生成的 XML 无法解析：$($_.Exception.Message)" "检查 $script:XmlPath" }
  Write-Ok "已写入 $script:XmlPath"
  Write-Info "自我重启命令（RW_RESTART_CMD）：$RestartCmd"
}

# 14) 安装/刷新服务
#     注意：Windows 服务名＝XML 的 <id>＝$WrapperName；<name>（$ServiceName）只是显示名。
#     所以 SCM 查询一律用 $WrapperName（Get-Service -Name 不按显示名匹配）。
$script:Step = '安装并启动服务'
$svc = Get-Service -Name $WrapperName -ErrorAction SilentlyContinue
if ($svc) {
  Write-Info "服务已存在（$($svc.Name)，状态 $($svc.Status)）：走 refresh，把 XML 改动推给 SCM"
  if (-not $WhatIfOnly) {
    $r = Invoke-WinSw $CMD_REFRESH 3 2
    if ($r.Code -ne 0) {
      Fail "refresh 失败（退出码 $($r.Code)）：$($r.Out -join ' / ')" `
        "改名冲突或 XML 与服务已注册的 ID 不一致时会发生：确认 $($script:XmlPath) 的 <id> 是 $WrapperName，必要时先跑 uninstall-service.ps1。"
    }
    Write-Ok 'refresh 完成'
  }
}
else {
  if ($WhatIfOnly) { Write-Info "WhatIf：会执行 & `"$script:WrapperExe`" $CMD_INSTALL" }
  else {
    $r = Invoke-WinSw $CMD_INSTALL 3 2
    if ($r.Code -ne 0) {
      $hint = 'WinSW 退出码取自 Win32_Service.Create：1073=同名服务已存在，5=拒绝访问（没用管理员终端）。'
      Fail "install 失败（退出码 $($r.Code)）：$($r.Out -join ' / ')`n  提示：$hint" `
        "先跑 scripts\windows\uninstall-service.ps1 -ServiceDir `"$ServiceDir`" 清掉旧注册，再重跑本脚本。"
    }
    $script:InstalledNow = $true
    Write-Ok "服务已注册：$ServiceName（服务 ID：$WrapperName，启动类型：自动，账户：LocalSystem）"
  }
}
# 等待 SCM 落定（服务刚注册时可能短暂查不到）
if (-not $WhatIfOnly) {
  for ($i = 0; $i -lt 10; $i++) { if (Get-Service -Name $WrapperName -ErrorAction SilentlyContinue) { break }; Start-Sleep -Seconds 1 }
}

# 15) 启动服务并等 Running
if (-not $WhatIfOnly) {
  $cur = Get-Service -Name $WrapperName -ErrorAction SilentlyContinue
  if ($cur -and $cur.Status -eq 'Running') { Write-Info '服务已在运行，跳过 start' }
  else {
    $r = Invoke-WinSw $CMD_START 3 2
    if ($r.Code -ne 0) {
      Fail "start 失败（退出码 $($r.Code)）：$($r.Out -join ' / ')" `
        "看 $LogDir\$WrapperName.err.log 与服务事件日志（事件查看器 → Windows 日志 → 应用程序）。常见原因：node.exe 路径错、server\index.js 路径错、端口被占。"
    }
    $script:StartedNow = $true
  }
  $deadline = (Get-Date).AddSeconds(60)
  $state = $null
  while ((Get-Date) -lt $deadline) {
    $s = Get-Service -Name $WrapperName -ErrorAction SilentlyContinue
    if ($s -and $s.Status -eq 'Running') { $state = $s; break }
    Start-Sleep -Seconds 2
  }
  if (-not $state) {
    Fail "服务在 60 秒内没有进入 Running。" `
      "看 $LogDir\$WrapperName.err.log 与 $LogDir\$WrapperName.wrapper.log；状态查询：& `"$script:WrapperExe`" $CMD_STATUS"
  }
  Write-Ok "服务状态：Running（Windows 服务名 $WrapperName，显示名 $ServiceName）"
}

# 16) 防火墙
$script:Step = '放行防火墙'
if ($SkipFirewall) { Write-Warn2 '按 -SkipFirewall 跳过防火墙放行（外网将访问不到）。' }
else { Invoke-FirewallStep }

# 17) 自检
$script:Step = '自检'
if ($SkipSelfCheck) { Write-Warn2 '按 -SkipSelfCheck 跳过自检。' }
elseif (-not (Test-Path -LiteralPath $selfCheck)) { Write-Warn2 "自检脚本不存在，跳过：$selfCheck" }
else { Invoke-SelfCheck }

# 18) 收尾
Write-Section '安装完成'
Write-Host "  服务名      ：$ServiceName"
Write-Host "  包装器      ：$script:WrapperExe"
Write-Host "  配置        ：$script:XmlPath"
Write-Host "  服务日志    ：$LogDir\$WrapperName.out.log / $WrapperName.err.log / $WrapperName.wrapper.log"
Write-Host "  后台任务日志：$JobsDir"
Write-Host "  访问入口    ：http://<本机IP>:$Port"
Write-Host ''
Write-Host '  常用命令（管理员 PowerShell）：' -ForegroundColor White
Write-Host "    状态：& `"$script:WrapperExe`" $CMD_STATUS"
Write-Host "    停止：& `"$script:WrapperExe`" $CMD_STOP"
Write-Host "    启动：& `"$script:WrapperExe`" $CMD_START"
Write-Host "    重启：& `"$script:WrapperExe`" restart"
Write-Host "    自我重启（平台内部用）：& `"$script:WrapperExe`" restart!"
Write-Host "    卸载：powershell -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'uninstall-service.ps1')`" -ServiceDir `"$ServiceDir`""
Write-Host ''
Write-Host '  还没做的验证（重启一次客户机后自己确认）：' -ForegroundColor Yellow
Write-Host "    1) 开机自启：重启后 & `"$script:WrapperExe`" status 应为 Started"
Write-Host "    2) 崩溃拉起：Stop-Process -Name node -Force 后等 10 秒，服务应自动回到 Running"
Write-Host ''
if ($WhatIfOnly) { Write-Host '  本次为 -WhatIfOnly，未做任何改动。' -ForegroundColor Yellow }
