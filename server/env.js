// server/env.js - 环境事实的单一来源（部署时确定，不随会话变化）
// 目的：引擎代码里不再出现平台专属字面量（路径/服务名/搜索后端/临时目录），换环境只改环境变量。
// 口径：默认值＝由代码自身位置与操作系统推导（换机器不用改配置）；本模块**只收环境事实**，不收行为规则与业务配置。
// 依据：《RW-Agent 架构 v1.1》§3.1（环境无关）；验收 G1 / RA-01；D2′ 客户机交付（Windows Server）。
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// 平台目录＝本文件（server/env.js）的上一级——由代码自身位置推导，不写死部署路径。
// 为什么不能写死 '/srv/harness-workbench'：那是**这台机器**的部署路径，不是平台的定义。
// 写死后客户机（Windows Server）上所有"平台目录 vs 业务工作区"的判断（自动提交豁免、快照范围、自愈）
// 都会拿一个不存在的路径去比，从而走错分支；而且本地开发机上也一样错。
export const RW_PLATFORM_DIR = process.env.RW_PLATFORM_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Agent 工作区＝平台目录的**兄弟目录**（现行部署 /srv/harness-workbench + /srv/rw-workspace 正是这个关系）。
// 不写死 '/srv/rw-workspace'：客户机上没有 /srv；这条关系在任何盘符、任何安装路径下都成立。
export const RW_WORKSPACE = process.env.RW_WORKSPACE
  || path.resolve(RW_PLATFORM_DIR, '..', 'rw-workspace');

export const RW_SKILLS = process.env.RW_SKILLS || path.join(RW_WORKSPACE, 'skills');     // 技能根目录
export const RW_SERVICE = process.env.RW_SERVICE || 'rw-test';                           // 服务名（self-heal 用）

// 运行平台：提示词要如实告诉模型"本机是哪一种系统"——主机是 Windows Server 时还说"本机是 Linux"，
// 模型就会写出跑不通的命令（路径写法/可用工具全不一样），这类错由用户承担、且很难自查。
export const RW_OS = process.platform;
export const RW_OS_CN = RW_OS === 'win32' ? 'Windows' : (RW_OS === 'darwin' ? 'macOS' : 'Linux');

// 自我重启命令：必须由**本进程之外**的看守者（systemd / NSSM / pm2 / sc …）把服务重新拉起来。
// 留空＝按平台默认（Linux：systemctl restart <RW_SERVICE>；其它平台没有通用默认，见 restart.js:restartPlan）。
// 为什么是一条命令而不是一个"平台"开关：各家的重启方式本来就是一条命令，多一层枚举只是多一处会写错的地方。
// 注：空格分词，需要带空格的路径时用引号，如 RW_RESTART_CMD="C:\Program Files\nssm\nssm.exe" restart rw-test
export const RW_RESTART_CMD = process.env.RW_RESTART_CMD || '';

// 后台任务（run_long_task）日志目录：默认用操作系统的临时目录，不写死 '/tmp'（Windows 上没有 /tmp）。
// 与 DSH 同做法：dsh-spill-local / dsh-subprocess-local 都用 os.tmpdir()。
// DSH 另有一条 Windows 注记（dsh-workflow-worker-thread）：TMP/TEMP/USERPROFILE 全空时 os.tmpdir()
// 会退化成相对路径 "undefined\temp"，落到 cwd 下——故此处只在它是绝对路径时才用，否则退回平台目录内的 .tmp。
// 为什么留一个覆盖开关（RW_JOBS_DIR）：操作系统临时目录会被清理——Linux 的 systemd-tmpfiles、
// Windows Server 的 SilentCleanup（KB4506040，登录会话超 7 天时删 %TEMP%）都算在内。日志随任务落库、
// 事后还要按 jobId 取回，所以长期无人值守的部署应把它指到业务盘上持久目录（见 Windows 部署文档），
// 默认值只是为了"不配也能跑"。
const OS_TMP = os.tmpdir();
const TMP_BASE = path.isAbsolute(OS_TMP) ? OS_TMP : path.join(RW_PLATFORM_DIR, '.tmp');
export const RW_JOBS_DIR = process.env.RW_JOBS_DIR || path.join(TMP_BASE, 'rw-jobs');

// 文件系统根：full 权限会话的 root 就是它（"不限制路径"）。
// 为什么要有这个名字：以前各处写死 '/'，而 Windows 上 '/' 会被 path.resolve 成"当前盘根"，
// 既不是"不限制"的意思，拼字符串判包含关系时也恒为假；派生出平台所在盘的盘根（POSIX 上就是 '/'），
// "不限制"与"盘根"两个意思从此落在同一个出处。
export const RW_FS_ROOT = path.parse(RW_PLATFORM_DIR).root;

export const RW_SEARCH_ENGINE = process.env.RW_SEARCH_ENGINE || 'SearXNG';               // 联网搜索后端名
export const RW_IDLE_MIN = Number(process.env.RW_IDLE_MIN || 60);                        // 长空闲判定阈值（分钟；C5 豁免归因用）

// ---- v0.3 §7.1 ⑦/②：两个"可替换实现"的选择开关（默认值＝现行实现，行为不变）----
// 存储（v0.3 §4.1「存储走接口」/ G1「不依赖我们的数据库」）：选择 server/storage/ 下的实现。
export const RW_STORAGE = process.env.RW_STORAGE || 'mysql';
// 执行后端（v0.3 §4.2 三层分离的第三层 / §5 跨平台）：选择 server/exec/ 下的实现。
export const RW_EXEC_BACKEND = process.env.RW_EXEC_BACKEND || 'local';
