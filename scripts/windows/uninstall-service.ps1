<#
.SYNOPSIS
  Roni Workbench · Windows Server 卸载脚本（停服务 → 卸服务 → 保留业务数据）

.DESCRIPTION
  只做三件事：停止服务、从 SCM 注销服务、报告哪些东西被留下了。
  **不删除任何业务数据**：数据库在远端 MySQL，本脚本一行都不碰；平台目录、Agent 工作区、
  日志目录、后台任务目录全部原样保留（见脚本末尾的清单）。

  想连文件一起清掉，请手工删除 —— 脚本不该替客户决定删什么。

.NOTES
  要求 Windows PowerShell 5.1、管理员权限。
  卸载后 WinSW 会在事件日志（Application 源）留下注册信息，属正常现象。
#>
[CmdletBinding()]
param(
  # 包装器目录：rwtest.exe / rwtest.xml / logs 所在目录。默认＝平台目录下的 svc。
  [string]$ServiceDir,
  # 平台代码目录（含 server\index.js）。不给则按本脚本位置推导。
  [string]$PlatformDir,
  # 包装器文件名（不含 .exe）＝Windows 服务名（XML 的 <id>）。必须与安装时一致。
  [string]$WrapperName = 'rwtest',
  [switch]$WhatIfOnly     # 只报告将要做什么，不实际动服务
)

$ErrorActionPreference = 'Stop'
$script:Step = '启动'
$script:StoppedNow = $false
$script:UninstalledNow = $false

$CMD_STOP = 'stop'
$CMD_UNINSTALL = 'uninstall'
$CMD_STATUS = 'status'

function Write-Section([string]$Text) { Write-Host ''; Write-Host "=== $Text ===" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Write-Info([string]$Text) { Write-Host "  [ ]    $Text" }

function Fail([string]$Message, [string]$HowToRollback) {
  Write-Host ''
  Write-Host "卸载失败（步骤：$script:Step）" -ForegroundColor Red
  Write-Host "  原因：$Message" -ForegroundColor Red
  if ($HowToRollback) { Write-Host "  回退：$HowToRollback" -ForegroundColor Yellow }
  Write-Host '  注意：卸载失败不改动任何数据，服务可能仍处于「已停止」或「已注销一半」的状态，可重跑本脚本。' -ForegroundColor Yellow
  exit 1
}

function Invoke-Native([string]$Exe, [string[]]$ArgList) {
  $out = & $Exe @ArgList 2>&1 | ForEach-Object { "$_" }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = @($out) }
}

# 带重试的 WinSW CLI 调用（SCM 状态落定有延迟）
function Invoke-WinSw([string]$Command, [int]$Retry = 5, [int]$DelaySec = 2) {
  $last = $null
  for ($i = 0; $i -lt $Retry; $i++) {
    $last = Invoke-Native $script:WrapperExe @($Command)
    if ($last.Code -eq 0) { return $last }
    Start-Sleep -Seconds $DelaySec
  }
  return $last
}

# ============================ 主流程 ============================

Write-Host ''
Write-Host 'Roni Workbench · Windows Server 卸载（保留业务数据）' -ForegroundColor White
if ($WhatIfOnly) { Write-Host '模式：-WhatIfOnly（只报告，不落地）' -ForegroundColor Yellow }

$script:Step = '前置检查'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail '当前不是管理员终端。' '右键 PowerShell →「以管理员身份运行」，再执行本脚本。'
}
Write-Ok "管理员权限：$($identity.Name)"

if (-not $ServiceDir) {
  if ($PlatformDir) { $ServiceDir = Join-Path $PlatformDir 'svc' }
  else {
    $cand = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    if (Test-Path -LiteralPath (Join-Path $cand 'server\index.js')) { $ServiceDir = Join-Path $cand 'svc' }
    else { Fail '既没给 -ServiceDir 也无法推导平台目录。' '显式传：-ServiceDir "C:\rw-test\svc"' }
  }
}
$dirExists = Test-Path -LiteralPath $ServiceDir
if ($dirExists) { $ServiceDir = (Resolve-Path -LiteralPath $ServiceDir).Path }
$script:WrapperExe = Join-Path $ServiceDir "$WrapperName.exe"
$xmlPath = Join-Path $ServiceDir "$WrapperName.xml"

Write-Info "包装器目录：$ServiceDir"
Write-Info "Windows 服务名：$WrapperName"

# 目录/包装器不在不构成失败：注册信息可能还在 SCM 里，此时用 sc.exe 兜底
$haveWrapper = $dirExists -and (Test-Path -LiteralPath $script:WrapperExe)
if (-not $haveWrapper) {
  Write-Warn2 "包装器不可用（目录或文件缺失）：$script:WrapperExe"
  Write-Warn2 "将改用 sc.exe 兜底（只能停/删服务，不碰数据）。"
}

$svc = Get-Service -Name $WrapperName -ErrorAction SilentlyContinue

# 1) 已经没有了 → 幂等成功
if (-not $svc) {
  Write-Ok "服务 $WrapperName 未注册（可能已卸载过）。"
}
else {
  # 2) 停服务（没有包装器时用 sc.exe 兜底）
  $script:Step = '停止服务'
  if ($svc.Status -eq 'Stopped') { Write-Info "服务已是 Stopped，跳过 stop" }
  elseif ($WhatIfOnly) {
    if ($haveWrapper) { Write-Info "WhatIf：会执行 & `"$script:WrapperExe`" $CMD_STOP" }
    else { Write-Info "WhatIf：会执行 sc.exe stop $WrapperName" }
  }
  else {
    Write-Info "停止服务（当前状态 $($svc.Status)）…"
    if ($haveWrapper) { $r = Invoke-WinSw $CMD_STOP 3 3 } else { $r = Invoke-Native 'sc.exe' @('stop', $WrapperName) }
    if ($r.Code -ne 0) {
      Fail "stop 失败（退出码 $($r.Code)）：$($r.Out -join ' / ')" `
        "手工再试：sc.exe stop $WrapperName ；或任务管理器结束 node.exe 后重跑本脚本。"
    }
    $script:StoppedNow = $true
    # 等 SCM 真的停稳（否则 uninstall 可能撞「服务标记为删除」）
    $deadline = (Get-Date).AddSeconds(45)
    $st = $null
    while ((Get-Date) -lt $deadline) {
      $s = Get-Service -Name $WrapperName -ErrorAction SilentlyContinue
      if (-not $s -or $s.Status -eq 'Stopped') { $st = $s; break }
      Start-Sleep -Seconds 2
    }
    if ($st -and $st.Status -ne 'Stopped') {
      Fail "服务在 45 秒内没有停稳（当前 $($st.Status)）。" `
        "看 $ServiceDir\logs\$WrapperName.err.log；必要时 Stop-Process -Name node -Force 后重跑本脚本。"
    }
    Write-Ok '服务已停止'
  }

  # 3) 卸服务（没有包装器时用 sc.exe 兜底）
  $script:Step = '注销服务'
  if ($WhatIfOnly) {
    if ($haveWrapper) { Write-Info "WhatIf：会执行 & `"$script:WrapperExe`" $CMD_UNINSTALL" }
    else { Write-Info "WhatIf：会执行 sc.exe delete $WrapperName" }
  }
  else {
    if ($haveWrapper) { $r = Invoke-WinSw $CMD_UNINSTALL 3 3 } else { $r = Invoke-Native 'sc.exe' @('delete', $WrapperName) }
    if ($r.Code -ne 0) {
      Fail "uninstall 失败（退出码 $($r.Code)）：$($r.Out -join ' / ')" `
        "手工再试：sc.exe delete $WrapperName （若提示「标记为删除」，等服务句柄释放后重跑）。"
    }
    $script:UninstalledNow = $true
    Write-Ok "服务已注销：$WrapperName"
  }
}

# 4) 数据保留清单（只报告，不删除）
$script:Step = '报告保留内容'
$platformGuess = $null
if ($PlatformDir) { $platformGuess = $PlatformDir }
else {
  # ServiceDir 默认是 <平台>\svc
  $cand = Split-Path -Parent $ServiceDir
  if ($cand -and (Test-Path -LiteralPath (Join-Path $cand 'server\index.js'))) { $platformGuess = $cand }
}

Write-Section '以下内容一律未被删除'
Write-Host '  1) 远端 MySQL 数据库      本脚本完全不接触（数据库不在本机）'
if ($haveWrapper) {
  Write-Host "  2) 包装器与配置            $ServiceDir\$WrapperName.exe（$WrapperName.xml）（保留，便于重装）"
  if (Test-Path -LiteralPath (Join-Path $ServiceDir 'logs')) { Write-Host "  3) 服务日志                $ServiceDir\logs\（保留，便于事后排查）" }
  else { Write-Host "  3) 服务日志                $ServiceDir\logs\（不存在）" }
}
else {
  Write-Host "  2) 包装器与配置            已不存在（$ServiceDir）"
  Write-Host "  3) 服务日志                已不存在（$ServiceDir\logs）"
}
if ($platformGuess) {
  Write-Host "  4) 平台代码目录            $platformGuess（含 .env、node_modules、web\dist）"
  Write-Host "  5) Agent 工作区            $(Join-Path (Split-Path -Parent $platformGuess) 'rw-workspace')（含 uploads\、skills\）"
  Write-Host "  6) 后台任务日志            $(Join-Path $platformGuess 'logs\jobs')"
}
else {
  Write-Host '  4) 平台代码目录            （未能推导，请自行确认：含 .env 与 node_modules 的那个目录）'
  Write-Host '  5) Agent 工作区            （平台目录的兄弟目录 rw-workspace）'
}
Write-Host ''
Write-Host '  真要彻底清理，请**人工确认后**再执行（本脚本不会替你跑）：' -ForegroundColor Yellow
if (Test-Path -LiteralPath $ServiceDir) { Write-Host "    Remove-Item -Recurse -Force `"$ServiceDir`"" }
if ($platformGuess) {
  Write-Host "    Remove-Item -Recurse -Force `"$platformGuess`""
  Write-Host "    Remove-Item -Recurse -Force `"$(Join-Path (Split-Path -Parent $platformGuess) 'rw-workspace')`""
}
Write-Host ''
Write-Host '  防火墙规则也未改动。不再需要时手工删除：' -ForegroundColor Yellow
Write-Host '    netsh advfirewall firewall show rule name=all dir=in     # 先找到规则名'
Write-Host '    netsh advfirewall firewall delete rule name="rw-test 880"'
Write-Host ''
if ($WhatIfOnly) { Write-Host '  本次为 -WhatIfOnly，未做任何改动。' -ForegroundColor Yellow }
else { Write-Host '  卸载完成。' -ForegroundColor Green }
