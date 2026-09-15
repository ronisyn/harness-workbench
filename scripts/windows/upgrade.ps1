<#
.SYNOPSIS
  Roni Workbench · Windows Server 升级脚本（先停服务，再 git pull）

.DESCRIPTION
  顺序是刻意的，不要改：
    前置检查（含 git 仓库状态）→ 停服务 → git pull → 需要才 npm ci → 需要才构建前端 → 启动 → 自检。

  为什么必须先停服务再 pull：Windows 上正在运行的 Node 进程会占用已加载的文件，
  git 覆盖这些文件会报 EPERM/EBUSY（不是「可以随意覆盖」的语义）；
  而且 npm ci 会整目录重写 node_modules，更不能和运行中的进程并行。
  依据：proposals/D2-Windows-Server服务化调研.md §4.7。

  失败策略：任一环节失败就**停在这**，服务保持「已停止」这种可诊断状态，并打印手工命令。
  不会自动回滚代码（回滚要不要做、回到哪个 commit 是人的决定），但会把旧 commit 打出来。

.NOTES
  要求 Windows PowerShell 5.1、管理员权限。不碰 .env、不碰业务数据。
  运行手册：scripts/windows/DEPLOY-Windows.md
#>
[CmdletBinding()]
param(
  # 平台代码目录（git 仓库根）。不给则按本脚本位置推导 scripts\windows\ -> 平台根。
  [string]$PlatformDir,
  # 包装器目录：rwtest.exe / rwtest.xml 所在目录。默认＝平台目录下的 svc。
  [string]$ServiceDir,
  # 包装器文件名（不含 .exe）＝Windows 服务名（XML 的 <id>）。
  [string]$WrapperName = 'rwtest',
  # 服务监听端口（自检用；应与 .env 的 PORT 一致）。
  [int]$Port = 880,
  # 自检用管理员账号/密码。默认从平台 .env 的 RW_ADMIN_USER / RW_ADMIN_PASS 读。
  [string]$AdminUser,
  [string]$AdminPass,
  [switch]$SkipStop,        # 只拉代码/构建，不碰服务（服务会一直跑着 —— 仅限排查用，会撞文件锁）
  [switch]$KeepStopped,     # 升级完不启动服务（把服务留在停止状态）
  [switch]$SkipSelfCheck,   # 不跑自检
  [switch]$WhatIfOnly       # 只打印将要执行的步骤，不落地
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$script:Step = '启动'
$script:StoppedNow = $false
$script:StartedNow = $false
$script:OldCommit = $null
$script:NewCommit = $null
$script:BackupDir = $null
$script:WrapperExe = $null
$script:EnvMap = @{}

$CMD_START = 'start'
$CMD_STOP = 'stop'
$CMD_STATUS = 'status'

function Write-Section([string]$Text) { Write-Host ''; Write-Host "=== $Text ===" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Write-Info([string]$Text) { Write-Host "  [ ]    $Text" }

# 失败＝停在可诊断状态：说清现在是什么状态、怎么手工继续/回退
function Fail([string]$Message, [string]$HowToRecover) {
  Write-Host ''
  Write-Host "升级失败（步骤：$script:Step）" -ForegroundColor Red
  Write-Host "  原因：$Message" -ForegroundColor Red
  Write-Host ''
  Write-Host '  当前状态：' -ForegroundColor Yellow
  if ($script:StoppedNow) { Write-Host "    服务 $WrapperName 已被本脚本停止（未启动起来）。" -ForegroundColor Yellow }
  else { Write-Host "    服务 $WrapperName 未被本脚本停止。" -ForegroundColor Yellow }
  if ($script:OldCommit) { Write-Host "    升级前 commit：$script:OldCommit" -ForegroundColor Yellow }
  if ($script:NewCommit) { Write-Host "    pull 后 commit：$script:NewCommit" -ForegroundColor Yellow }
  else { Write-Host '    git pull 未完成（工作区仍是升级前的代码，除非提示了别的错误）。' -ForegroundColor Yellow }
  Write-Host ''
  if ($HowToRecover) { Write-Host "  怎么继续：$HowToRecover" -ForegroundColor Yellow }
  Write-Host '  手工命令（按需选）：' -ForegroundColor Yellow
  Write-Host "    看状态：& `"$script:WrapperExe`" $CMD_STATUS"
  Write-Host "    再启动：& `"$script:WrapperExe`" $CMD_START"
  Write-Host '    回退代码：先 stop，再 git reset --hard <升级前 commit>，必要时 npm ci，然后 start'
  Write-Host '    看日志  ：日志目录在包装器目录下的 logs\（*.out.log / *.err.log / *.wrapper.log）'
  exit 1
}

function Invoke-Native([string]$Exe, [string[]]$ArgList) {
  $out = & $Exe @ArgList 2>&1 | ForEach-Object { "$_" }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = @($out) }
}

function Invoke-WinSw([string]$Command, [int]$Retry = 5, [int]$DelaySec = 2) {
  $last = $null
  for ($i = 0; $i -lt $Retry; $i++) {
    $last = Invoke-Native $script:WrapperExe @($Command)
    if ($last.Code -eq 0) { return $last }
    Start-Sleep -Seconds $DelaySec
  }
  return $last
}

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

function Get-GitHead([string]$Dir) {
  $r = Invoke-Native $gitExe @('-C', $Dir, 'rev-parse', 'HEAD')
  if ($r.Code -ne 0) { return $null }
  return ("$($r.Out -join '')").Trim()
}

function Test-PkgChanged([string]$Dir, [string]$From, [string]$To) {
  if (-not $From -or -not $To -or $From -eq $To) { return $false }
  # 只看依赖清单是否变化：node_modules 是否需要重装取决于这两个文件
  $r = Invoke-Native $gitExe @('-C', $Dir, 'diff', '--name-only', "$From..$To", '--', 'package.json', 'package-lock.json')
  if ($r.Code -ne 0) { return $false }
  return (@($r.Out) | Where-Object { "$_".Trim() }).Count -gt 0
}

function Invoke-SelfCheck([string]$NodeExe) {
  $base = "http://127.0.0.1:$Port"
  $u = $AdminUser; if (-not $u) { $u = $script:EnvMap['RW_ADMIN_USER'] }
  $p = $AdminPass; if (-not $p) { $p = $script:EnvMap['RW_ADMIN_PASS'] }
  if (-not $u -or -not $p) { Write-Warn2 '自检跳过：缺管理员账号（-AdminUser / -AdminPass 或 .env 的 RW_ADMIN_*）。'; return }
  $sc = Join-Path $PlatformDir 'scripts\selfcheck.mjs'
  if (-not (Test-Path -LiteralPath $sc)) { Write-Warn2 "自检脚本不存在，跳过：$sc"; return }
  if ($WhatIfOnly) { Write-Info "WhatIf：会执行 & `"$NodeExe`" `"$sc`" $base $u <password>"; return }
  Write-Info "执行自检：& `"$NodeExe`" `"$sc`" $base $u <password>"
  $r = Invoke-Native $NodeExe @($sc, $base, $u, $p)
  Write-Host ''
  foreach ($line in $r.Out) { Write-Host "  $line" }
  Write-Host ''
  if ($r.Code -eq 0) { Write-Ok '自检全部通过。' }
  else { Write-Warn2 "自检未全部通过（退出码 $($r.Code)）：按上面的 ❌ 行定位（连不上服务/登录失败/接口 500/对话无输出）。" }
}

# ============================ 主流程 ============================

Write-Host ''
Write-Host 'Roni Workbench · Windows Server 升级（先停服务，再 git pull）' -ForegroundColor White
if ($WhatIfOnly) { Write-Host '模式：-WhatIfOnly（只打印步骤）' -ForegroundColor Yellow }
if ($SkipStop) { Write-Host '注意：-SkipStop 会让服务一直运行着拉代码，很可能撞 Windows 文件锁（EPERM）。' -ForegroundColor Yellow }

$script:Step = '前置检查'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail '当前不是管理员终端。' '右键 PowerShell →「以管理员身份运行」，再执行本脚本。'
}
Write-Ok "管理员权限：$($identity.Name)"

if (-not $PlatformDir) {
  $cand = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  if (Test-Path -LiteralPath (Join-Path $cand 'server\index.js')) { $PlatformDir = $cand }
  else { Fail '无法推导平台目录（本脚本不在 <平台>\scripts\windows\ 下）。' '显式传：-PlatformDir "C:\rw-test"' }
}
$PlatformDir = (Resolve-Path -LiteralPath $PlatformDir).Path
if (-not $ServiceDir) { $ServiceDir = Join-Path $PlatformDir 'svc' }
$script:WrapperExe = Join-Path $ServiceDir "$WrapperName.exe"

Write-Info "平台目录    ：$PlatformDir"
Write-Info "包装器目录  ：$ServiceDir"
Write-Info "Windows 服务名：$WrapperName"

if (-not (Test-Path -LiteralPath (Join-Path $PlatformDir 'server\index.js'))) { Fail "平台上没有 server\index.js：$PlatformDir" '用 -PlatformDir 指向真实平台目录。' }
$script:EnvMap = Read-DotEnv (Join-Path $PlatformDir '.env')
if ($script:EnvMap['PORT'] -and [int]$script:EnvMap['PORT'] -ne $Port) {
  Write-Warn2 ".env 的 PORT=$($script:EnvMap['PORT']) 与 -Port $Port 不同；自检会打到 $Port，请核对。"
}

$gitExe = (Get-Command git -ErrorAction SilentlyContinue)
if (-not $gitExe) { Fail 'PATH 里找不到 git。' '装 Git for Windows 并重开管理员终端，或用别的方式更新代码后手工重启服务。' }
$gitExe = $gitExe.Source
Write-Ok "git：$gitExe"

$nodeCmd = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $nodeCmd) { Fail 'PATH 里找不到 node。' '确认 Node.js 已安装且服务账户/本终端都能看到它。' }
$nodeExe = $nodeCmd.Source

$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
if (-not $npmCmd) { $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue) }
if (-not $npmCmd) { Fail 'PATH 里找不到 npm。' '重开管理员终端；仍没有就重装 Node.js。' }
$npmExe = $npmCmd.Source

# 是不是 git 仓库（服务化交付的机器上应该是；不是的话只能手工更新代码）
$isRepo = (Invoke-Native $gitExe @('-C', $PlatformDir, 'rev-parse', '--is-inside-work-tree')).Code -eq 0
if (-not $isRepo) {
  Fail "$PlatformDir 不是 git 工作区，无法用 git pull 升级。" `
    '这台机器只能手工更新代码（覆盖文件后重跑 scripts\windows\install-service.ps1 的 refresh 流程），或把仓库 clone 过来重装。'
}
Write-Ok 'git 工作区检查通过'

# 未提交的本地改动：pull 可能失败或被夹带，先摆出来让人决定
$dirty = @(Invoke-Native $gitExe @('-C', $PlatformDir, 'status', '--porcelain')).Out
$dirty = @($dirty | Where-Object { "$_".Trim() -and "$_" -notmatch '^\?\?' })
if ($dirty.Count -gt 0) {
  Write-Warn2 "工作区有未提交的改动 $($dirty.Count) 处，git pull 可能失败或与改动冲突："
  $dirty | Select-Object -First 10 | ForEach-Object { Write-Host "      $_" -ForegroundColor Yellow }
  Write-Warn2 '建议先人工处理（提交或 stash）。若这些是平台自己改的代码，见 DEPLOY-Windows.md「自我改代码与升级」一节。'
}

$svc = Get-Service -Name $WrapperName -ErrorAction SilentlyContinue
if (-not $svc) { Write-Warn2 "服务 $WrapperName 未注册：本次只做代码更新，不做停/启服务。" }

# ---------- 1) 记录当前版本 + 备份将要被替换的依赖清单 ----------
$script:Step = '记录当前版本'
$script:OldCommit = Get-GitHead $PlatformDir
if (-not $script:OldCommit) { Fail '取不到当前 commit（git rev-parse HEAD 失败）。' '在平台目录手工跑 git rev-parse HEAD 看报错。' }
Write-Info "升级前 commit：$script:OldCommit"
$pkgBefore = Join-Path $PlatformDir 'package.json'
$lockBefore = Join-Path $PlatformDir 'package-lock.json'
$script:BackupDir = Join-Path $env:TEMP ("rw-upgrade-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if ($WhatIfOnly) { Write-Info "WhatIf：会把 package.json / package-lock.json 备份到 $script:BackupDir"; $script:BackupDir = $null }
else {
  New-Item -ItemType Directory -Force -Path $script:BackupDir | Out-Null
  foreach ($f in @($pkgBefore, $lockBefore)) { if (Test-Path -LiteralPath $f) { Copy-Item -LiteralPath $f -Destination $script:BackupDir -Force } }
  Write-Ok "依赖清单已备份：$script:BackupDir（pull 后用于比对依赖是否变化）"
}

# ---------- 2) 停服务（必须在 pull 之前）----------
$script:Step = '停止服务'
if ($SkipStop) { Write-Warn2 '按 -SkipStop 跳过停服务（很可能撞文件锁）。' }
elseif (-not $svc) { Write-Warn2 '服务未注册，无服务可停。' }
elseif ($WhatIfOnly) { Write-Info "WhatIf：会执行 & `"$script:WrapperExe`" $CMD_STOP" }
else {
  $cur = Get-Service -Name $WrapperName -ErrorAction SilentlyContinue
  if ($cur -and $cur.Status -eq 'Stopped') { Write-Info '服务已是 Stopped' }
  else {
    $r = Invoke-WinSw $CMD_STOP 3 3
    if ($r.Code -ne 0) { Fail "stop 失败（退出码 $($r.Code)）：$($r.Out -join ' / ')" "手工：& `"$script:WrapperExe`" $CMD_STOP" }
    $script:StoppedNow = $true
  }
  $deadline = (Get-Date).AddSeconds(45)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    $s = Get-Service -Name $WrapperName -ErrorAction SilentlyContinue
    if (-not $s -or $s.Status -eq 'Stopped') { $ok = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ok) { Fail '服务在 45 秒内没停稳，此时 pull 仍可能撞文件锁。' "手工确认 node 进程已退出：Get-Process node -ErrorAction SilentlyContinue；必要时 Stop-Process -Name node -Force" }
  Write-Ok "服务已停止（升级结束前会重新启动；失败时会停在停止状态并提示）"
}

# ---------- 3) git pull ----------
$script:Step = '拉取代码（git pull）'
if ($WhatIfOnly) {
  Invoke-Native $gitExe @('-C', $PlatformDir, 'fetch', '--dry-run') | Out-Null
  Write-Info 'WhatIf：会执行 git -C <平台目录> pull --ff-only'
}
else {
  $r = Invoke-Native $gitExe @('-C', $PlatformDir, 'pull', '--ff-only')
  Write-Host ''
  foreach ($line in $r.Out) { Write-Host "  $line" }
  Write-Host ''
  if ($r.Code -ne 0) {
    Fail "git pull 失败（退出码 $($r.Code)）。" `
      '代码未更新，服务仍是停止状态。依次排查：① 本地有未提交改动 → git stash / 提交；② 历史分叉（--ff-only 不允许合并）→ 人工决定 merge 还是 reset；③ 出网/认证失败 → 检查远端可达性与凭据。处理完重跑本脚本。'
  }
  Write-Ok 'git pull 完成'
}

# ---------- 4) 依赖：package.json / lock 变了才 npm ci ----------
$script:Step = '依赖安装（按需 npm ci）'
$script:NewCommit = Get-GitHead $PlatformDir
if ($script:NewCommit) { Write-Info "pull 后 commit：$script:NewCommit" }
if ($script:OldCommit -and $script:NewCommit -and $script:OldCommit -eq $script:NewCommit) { Write-Warn2 'commit 没变（仓库已是最新，或远端没更新）。' }

$lockChanged = $false
if ($null -ne $script:NewCommit) {
  $lockChanged = Test-PkgChanged $PlatformDir $script:OldCommit $script:NewCommit
}
# 兜底：git 比对不可用时，直接比文件内容
if (-not $lockChanged) {
  foreach ($pair in @(@('package.json', $pkgBefore), @('package-lock.json', $lockBefore))) {
    $old = Join-Path $script:BackupDir $pair[0]
    $new = $pair[1]
    if ((Test-Path -LiteralPath $old) -and (Test-Path -LiteralPath $new)) {
      if ((Get-FileHash -LiteralPath $old).Hash -ne (Get-FileHash -LiteralPath $new).Hash) { $lockChanged = $true }
    }
  }
}
$needCi = $lockChanged -or (-not (Test-Path -LiteralPath (Join-Path $PlatformDir 'node_modules')))

if ($WhatIfOnly) { Write-Info "WhatIf：需要 npm ci ＝ $needCi" }
elseif (-not $needCi) { Write-Ok 'package.json / package-lock.json 未变化，跳过 npm ci' }
else {
  Write-Info '依赖清单有变化（或 node_modules 缺失），执行 npm ci …'
  Push-Location $PlatformDir
  try { $r = Invoke-Native $npmExe @('ci') } finally { Pop-Location }
  if ($r.Code -ne 0) {
    $tail = ($r.Out | Select-Object -Last 20) -join "`n"
    Fail "npm ci 失败（退出码 $($r.Code)）：`n$tail" `
      "服务仍是停止状态。在 $PlatformDir 手工跑 npm ci 看完整报错（常见：npm registry 出网/代理、磁盘空间）。修好后重跑本脚本；要回退代码：git reset --hard $script:OldCommit 后 npm ci。"
  }
  Write-Ok 'npm ci 完成'
}

# ---------- 5) 前端构建 ----------
$script:Step = '前端构建（按需 npm run build）'
$distIndex = Join-Path $PlatformDir 'web\dist\index.html'
$needBuild = $lockChanged -or (-not (Test-Path -LiteralPath $distIndex))
if ($WhatIfOnly) { Write-Info "WhatIf：需要 npm run build ＝ $needBuild" }
elseif (-not $needBuild) { Write-Info '前端产物已在（web\dist\index.html），跳过 npm run build（仅依赖变化或产物缺失时才重建）' }
else {
  Push-Location $PlatformDir
  try { $r = Invoke-Native $npmExe @('run', 'build') } finally { Pop-Location }
  if ($r.Code -ne 0) {
    $tail = ($r.Out | Select-Object -Last 20) -join "`n"
    Fail "npm run build 失败（退出码 $($r.Code)）：`n$tail" `
      "服务仍是停止状态。手工跑 npm run build 看完整报错；只想先把服务拉起来（页面可能打不开、API 可用）可执行：& `"$script:WrapperExe`" $CMD_START"
  }
  Write-Ok '前端构建完成'
}

# ---------- 6) 启动服务 ----------
$script:Step = '启动服务'
if ($KeepStopped) {
  Write-Warn2 '按 -KeepStopped：服务保持停止状态，请人工确认后再启动。'
  Write-Host "      & `"$script:WrapperExe`" $CMD_START" -ForegroundColor Yellow
}
elseif (-not (Get-Service -Name $WrapperName -ErrorAction SilentlyContinue)) { Write-Warn2 '服务未注册，跳过启动。' }
elseif ($WhatIfOnly) { Write-Info "WhatIf：会执行 & `"$script:WrapperExe`" $CMD_START" }
else {
  $r = Invoke-WinSw $CMD_START 3 3
  if ($r.Code -ne 0) { Fail "start 失败（退出码 $($r.Code)）：$($r.Out -join ' / ')" "看日志目录下的 *.err.log；确认端口 $Port 没被别的进程占用。" }
  $script:StartedNow = $true
  $deadline = (Get-Date).AddSeconds(60)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    $s = Get-Service -Name $WrapperName -ErrorAction SilentlyContinue
    if ($s -and $s.Status -eq 'Running') { $ok = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ok) { Fail '服务在 60 秒内没有进入 Running。' "看日志目录下的 *.err.log / *.wrapper.log；状态：& `"$script:WrapperExe`" $CMD_STATUS" }
  Write-Ok '服务已启动（Running）'
}

# ---------- 7) 自检 ----------
$script:Step = '自检'
if ($SkipSelfCheck) { Write-Warn2 '按 -SkipSelfCheck 跳过自检。' }
elseif ($KeepStopped) { Write-Warn2 '服务被要求保持停止，跳过自检。' }
else { Invoke-SelfCheck $nodeExe }

# ---------- 8) 收尾 ----------
Write-Section '升级完成'
Write-Host "  升级前 commit：$script:OldCommit"
Write-Host "  升级后 commit：$(if ($script:NewCommit) { $script:NewCommit } else { '（未取到）' })"
Write-Host "  npm ci        ：$(if ($needCi) { '执行过' } else { '跳过（依赖未变）' })"
Write-Host "  前端构建      ：$(if ($needBuild) { '执行过' } else { '跳过' })"
Write-Host "  服务状态      ：$(if ($script:StartedNow) { 'Running（本脚本启动）' } elseif ($KeepStopped) { 'Stopped（-KeepStopped）' } else { '未改动' })"
Write-Host "  依赖清单备份  ：$(if ($script:BackupDir) { $script:BackupDir } else { '（无）' })"
Write-Host ''
if ($script:BackupDir) { Write-Host "  备份目录是临时目录，确认升级无误后可删：Remove-Item -Recurse -Force `"$script:BackupDir`"" -ForegroundColor DarkGray }
Write-Host '  回退到升级前版本（如需）：' -ForegroundColor Yellow
Write-Host "    & `"$script:WrapperExe`" $CMD_STOP"
Write-Host "    git -C `"$PlatformDir`" reset --hard $script:OldCommit"
Write-Host '    （依赖可能也要回退：npm ci ；然后）'
Write-Host "    & `"$script:WrapperExe`" $CMD_START"
Write-Host ''
