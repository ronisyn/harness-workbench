// server/env.js - 环境事实的单一来源（部署时确定，不随会话变化）
// 目的：引擎代码里不再出现平台专属字面量（路径/服务名/搜索后端/临时目录），换环境只改环境变量。
// 口径：默认值＝由代码自身位置与操作系统推导（换机器不用改配置）；本模块**只收环境事实**，不收行为规则与业务配置。
// 依据：《RW-Agent 架构 v1.1》§3.1（环境无关）；验收 G1 / RA-01；D2′ 客户机交付（Windows Server）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// 平台目录＝本文件（server/env.js）的上一级——由代码自身位置推导，不写死部署路径。
// 为什么不能写死 '/srv/harness-workbench'：那是**这台机器**的部署路径，不是平台的定义。
// 写死后客户机（Windows Server）上所有"平台目录 vs 业务工作区"的判断（自动提交豁免、快照范围、自愈）
// 都会拿一个不存在的路径去比，从而走错分支；而且本地开发机上也一样错。
export const RW_PLATFORM_DIR = process.env.RW_PLATFORM_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 平台版本号（v0.3 §4.1 运行面："…单进程可启动；**有版本号与变更说明**"）。
// 唯一出处＝`package.json` 的 `version`：本模块**只收环境事实**，不在这里另写一份版本字面量
// （同一份事实写两处，早晚漂移；变更说明的逐条依据见仓库根的 `CHANGELOG.md`）。
// 读不到／读不成 JSON 时**如实**报 '0.0.0' 并告警——不猜、不编（与 permissions 面"拿不到不假装"同一纪律）。
// 为什么是同步读一次而不是每处 import：它要在 MCP 握手（每次 initialize）与启动日志里即时可用，
// 且 `package.json` 是随包发布的静态文件，进程运行期不会变（平台版本要换必须改文件+重启）。
// `platformVersion()` 收一个路径参数是给夹具的缝：夹具要能断言"读不到时如实退回 0.0.0"，而不必真去挪 package.json。
export function platformVersion(pkgPath = path.join(RW_PLATFORM_DIR, 'package.json')) {
  try {
    const v = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    return (typeof v === 'string' && v.trim()) ? v.trim() : '0.0.0';
  } catch (e) {
    console.warn('[env] 读不到平台版本（package.json 缺失/不是合法 JSON），按 0.0.0 上报：' + ((e && e.message) || e));
    return '0.0.0';
  }
}
export const RW_VERSION = platformVersion();

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
// 知识检索后端（v0.3 §4.3「记忆」行「全文检索打底…**向量留接口位置后补**」）：选择 server/kbsearch/ 下的实现。
// 当前两个实现：`fts`（MySQL FULLTEXT + ngram，缺省）/ `like`（纯 JS 子串匹配，零 SQL —— 没有 MySQL 的机器
// 用它在**已读出的记录**上检索；它**不是** fts 的兜底，是并列的第二个实现：`mode` 如实报 like、degraded=true）。
// 将来写好向量实现模块、在 server/kbsearch/index.js 的实现表加一行，然后把这台机器的 RW_KB_SEARCH 指过去
// 即生效——调用方不改（`kb_search` 已把 `db` 与 `storage` 两样都传上，各实现取自己要的那一样）。
export const RW_KB_SEARCH = process.env.RW_KB_SEARCH || 'fts';
// 提醒投递通道（v0.3 §5「提醒由产品层配置的通道投递，引擎提供通道接口」）：选择 `server/reminders/` 下的实现。
// **默认空串 = 没配通道**（如实语义：本仓现在只有飞书一条真实通道，没有"默认通道"这回事）；
// 配了不存在的实现名 ⇒ `server/reminders/index.js` 在**装配期**如实抛错，不静默回落（§4.6）。
// 飞书通道要同时配 FEISHU_APP_ID / FEISHU_APP_SECRET（缺了 `available()` 如实报 false，投递时报明确错误）。
export const RW_REMINDER_CHANNEL = process.env.RW_REMINDER_CHANNEL || '';

// ---- v0.3 §4.6 沙箱的严格语义开关 ----
// 默认 **关**：拿不到沙箱（本机没有可用 runner）时按"显式降级"走——如实上报 enforcement:'none'、
// 留一条 sandbox:degrade 账、提高审批，而不是打死服务。这是**迁移期的登记偏离**（见冲突登记 C-45），
// 理由：客户端机器上 bwrap/nsjail 往往不存在，装不上的机器直接起不来服务，比"降级但可见"更糟。
// 开（=1/true/yes/on）＝v0.3 §4.6 的字面语义：拿不到沙箱模式就**拒绝启动/拒绝执行**。
// 装上 bwrap 或配好 RW_SANDBOX_RUNNER 之后把开关打开，即完全落到文档口径，无需改代码。
// 为什么是函数而不是常量：判据要**调用时**读环境（夹具会在同进程里改 process.env 断言两种语义），
// 常量会在模块加载时就定死；收 env 参数是给夹具的缝（不传就读真实 process.env）。
// 真值表只有这一份实现——`server/sandbox/degrade.js` 的 sandboxRequired() 直接转调它。
export function sandboxRequiredEnv(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.RW_SANDBOX_REQUIRED ?? '').trim().toLowerCase());
}
