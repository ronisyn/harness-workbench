// test/probe-declaration.test.mjs - 「自造会话必须自己表明身份」的夹具（2026-09-17）
//
// 为什么值得单独钉一份：C1/C2 的读数被**我们自己发起的会话**污染过——2026-09-16 的归因实测：
// 新段 50 轮里 46 轮（92%）是我们自己发的（样本任务 37 轮 + `rw-run`/MCP/`RW_STORAGE` 等哨兵 9 轮），
// 占全部未命中的 97%，扣掉它们只剩 4 轮 ⇒ 按既有判据"轮次<30 不可判"。根因不是引擎缺陷（引擎侧零缺陷
// 证据已另存），而是这些会话的标题里**没有任何族标识** ⇒ 被 server/cohort.js 判成"真实流量"。
//
// 处置是"**让自造会话落进既有探针族**"（v0.3 §0.3.1："探针 ≠ 真实流量"、79 个会话必须落进探针或真实、
// 没有第三个去处）——口径本身一个字没改。所以本夹具要钉住两件相反的事：
//   ① 正向：用统一声明（`probeTitle`）建出来的会话**被判为探针**，不是真实流量；
//   ② 反向：把声明去掉 ⇒ 同一个标题当场变红（被判成真实流量）。**红不了的夹具等于没有夹具。**
// 判据不在这里重写：探针族的唯一实现是 server/cohort.js 的 `PROBE_TITLE_RE` / `PROBE_WHERE`，本夹具只用它。
//
// 覆盖到哪一层（如实）：
//   · `rw-run`：**行为级**——真跑一次建会话路径（假 db、不调模型），断言落库的那条标题被判为探针；
//   · `selfcheck` / `agent-smoke` / `rw-jsonrpc` / `rw-mcp-server`：**源码级**接线核对——这四个文件
//     一 import 就连网登录或起 stdio 服务（`selfcheck` 顶层就 fetch、两个适配器顶层 `serveStdio`），
//     夹具不碰它们，改为核对"必须引用唯一出处、且不再有裸标题旧写法"。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_TITLE_RE, PROBE_TITLE_PREFIX, probeTitle, PROBE_WHERE, REAL_WHERE } from '../server/cohort.js';
import { runHeadless } from '../scripts/rw-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 判据的**同一份**正则：`PROBE_WHERE` 就是拿 `PROBE_TITLE_RE` 去 REGEXP 的（下面第 1 条断言这一点），
// 所以这里用 JS 正则判定 ≡ 用真判据判定，不是另写一份口径。
const RE = new RegExp(PROBE_TITLE_RE);
const isProbe = (title) => RE.test(String(title));
/** 反向核对用：把统一声明摘掉（＝改动之前的写法），看判据是不是当场翻面。 */
const undeclare = (title) => String(title).replace(PROBE_TITLE_PREFIX + ' ', '');

/** 会建会话的文件必须：①从唯一出处引声明；②用 `probeTitle()` 生成标题；③不再有"裸标题字面量"的旧写法。 */
function wiredOK(src, bareTitleRe) {
  return /from '\.\/cohort\.mjs'/.test(src) && /probeTitle\(/.test(src) && !bareTitleRe.test(src);
}
/** 递归收集脚本（用于"族前缀只有一处出处"的机检） */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('声明方式与判据同源：PROBE_WHERE 里嵌的就是 PROBE_TITLE_RE，probeTitle 的输出命中它', () => {
  assert.ok(PROBE_WHERE().includes(PROBE_TITLE_RE), 'PROBE_WHERE 必须仍用 PROBE_TITLE_RE 判标题（本夹具的 JS 判定因此等价于 SQL 判定）');
  assert.ok(REAL_WHERE().includes(PROBE_WHERE()), '真实流量 = ¬探针 ∧ ¬孤儿：它引用的是同一份探针判据，没被绕过');
  assert.ok(RE.test(probeTitle('rw-run: 看一眼磁盘')), '声明出来的标题必须命中探针族');
  assert.equal(PROBE_TITLE_PREFIX, '__probe__', '声明串本身也钉住：换前缀要连本夹具一起改（外部按标题检索的东西会跟着动）');
});

test('自造路径的标题都命中探针族；摘掉声明 ⇒ 当场变红（反向核对）', () => {
  const cases = [
    ['rw-run 新建会话', probeTitle('rw-run: 看一眼磁盘')],
    ['JSON-RPC session.chat', probeTitle('JSON-RPC: 你好')],
    ['MCP rw_chat', probeTitle('MCP: 你好')],
    ['selfcheck', probeTitle('selfcheck')],
    ['selfcheck（write 档）', probeTitle('selfcheck_write')],
    ['agent-smoke', probeTitle('smoke_agent')],
  ];
  for (const [who, t] of cases) {
    assert.ok(isProbe(t), who + ' 的标题必须被判为探针：' + t);
    assert.equal(isProbe(undeclare(t)), false, '反向核对：' + who + ' 摘掉声明后必须变成"真实流量"（否则这条夹具红不了）');
    assert.notEqual(undeclare(t), t, who + ' 的标题里确实有可摘的声明');
  }
});

test('真跑一次 rw-run 的建会话路径：落库的标题被判为探针（不是真实流量）', async () => {
  const inserts = [];
  const db = {
    query: async (sql, params = []) => {
      const s = String(sql);
      if (/^INSERT INTO conversations/.test(s)) { inserts.push(params); return { insertId: 77 }; }
      if (/^INSERT INTO messages/.test(s)) return { insertId: 555 };
      if (/SELECT id FROM accounts/.test(s)) return [{ id: 1 }];
      if (/FROM messages WHERE conversation_id/.test(s)) return [];
      if (/FROM settings WHERE skey=\?/.test(s)) return [];
      if (/SELECT COALESCE\(SUM\(cost\)/.test(s)) return [{ c: 0 }];
      if (/UPDATE conversations SET updated_at/.test(s)) return { affectedRows: 1 };
      return [];
    },
  };
  const { payload } = await runHeadless({
    task: '看一眼磁盘', db, quiet: true,
    runAgent: async () => ({ content: '看完了', toolLog: [], usage: {}, finishReason: 'stop' }),
    keys: {}, config: {}, RW_WORKSPACE: 'E:/tmp/ws', RW_FS_ROOT: 'E:/',
    ensureRun: async () => ({ id: 9001 }), markRun: async () => {}, env: {}, now: () => Date.now(),
  });

  assert.equal(payload.conversationCreated, true, '没给会话时 CLI 会新建一个（这正是要声明的那条路径）');
  assert.equal(inserts.length, 1, '新建会话只该发一次 INSERT');
  const title = inserts[0][1];
  assert.equal(title, probeTitle('rw-run: 看一眼磁盘'), '标题＝统一声明 + 人读说明（人读部分照旧，族前缀加在最前）');
  assert.ok(isProbe(title), '这条 self-made 会话必须落进探针族：' + title);
  assert.equal(isProbe(undeclare(title)), false, '反向核对：摘掉声明 ⇒ 同一条会话会被算进真实流量（这就是 C-53 的污染路径）');
});

test('五个自造路径都接到唯一出处（源码级核对；这四个文件不可 import，见文件头）', () => {
  // 裸标题写法＝**没有被 probeTitle(...) 包住**的标题字面量：人读说明（`'MCP: '`）照旧留在标题里，
  // 但必须出现在 probeTitle( 之后（负向先行断言 `(?<!probeTitle\()` 断的就是这件事）。
  const WIRED = [
    ['scripts/rw-run.mjs', /(?<!probeTitle\()'rw-run: '\s*\+/],
    ['scripts/rw-jsonrpc.mjs', /(?<!probeTitle\()'JSON-RPC: '\s*\+/],
    ['scripts/rw-mcp-server.mjs', /(?<!probeTitle\()'MCP: '\s*\+/],
    ['scripts/selfcheck.mjs', /'__selfcheck/],
    ['scripts/agent-smoke.mjs', /'__smoke_agent__'/],
  ];
  for (const [rel, bareTitleRe] of WIRED) {
    const src = read(rel);
    assert.ok(/from '\.\/cohort\.mjs'/.test(src), rel + ' 必须从唯一出处引 probeTitle（./cohort.mjs 转发 server/cohort.js）');
    assert.ok(/probeTitle\(/.test(src), rel + ' 必须用 probeTitle 生成标题，不许各写一份族字面量');
    assert.equal(bareTitleRe.test(src), false, rel + ' 里还留着旧的裸标题写法：' + bareTitleRe);
  }
  // 反向核对：拿"改动之前的那一行"喂给同一个扫描器，必须判为未接线（否则这套核对恒真）
  const OLD_MCP_LINE = "body: { title: 'MCP: ' + String(args.message).slice(0, 40), permission: PERMISSION }";
  assert.equal(wiredOK(OLD_MCP_LINE, /(?<!probeTitle\()'MCP: '\s*\+/), false, '反向核对：旧写法必须判红——扫描器真的会红');
  const NEW_MCP_LINE = "import { probeTitle } from './cohort.mjs';\nbody: { title: probeTitle('MCP: ' + String(args.message).slice(0, 40)) }";
  assert.equal(wiredOK(NEW_MCP_LINE, /(?<!probeTitle\()'MCP: '\s*\+/), true, '接线之后必须判绿（人读说明留在标题里不算裸写法）');
});

test('"一处出处"是机检的：scripts/ 与仓库根的脚本里不许再写死族前缀', () => {
  const targets = [
    ...walk(path.join(ROOT, 'scripts')),
    ...fs.readdirSync(ROOT).filter((f) => /^e2e-.*\.mjs$/.test(f)).map((f) => path.join(ROOT, f)),
  ];
  const hits = targets.filter((f) => fs.readFileSync(f, 'utf8').includes("'__probe__'"));
  assert.deepEqual(hits, [], '族前缀只能由 server/cohort.js 的 probeTitle 产出；这些脚本又写死了一份：' + hits.join('、'));
});

test('既有探针族字面量仍在族内（收紧 PROBE_TITLE_RE 时不许把它们挤出探针档）', () => {
  // 这些是改动之前就在探针族里的自造路径（cache-*/ra13/ra26/ra37），本轮一个字没改——
  // 若哪天判据收紧把它们挤出去，它们会**静默变成真实流量**，所以在这里留一条回归线。
  for (const t of ['__cache_fresh__', '__xsession_probe__', '__ra37_rebuild__', '__ra26_waitsides__',
    '__ra13_degrade__', '__ttl_probe_15s__', '__ttl2_30s__', 'PROBE', 'ST-x', 'B2C']) {
    assert.ok(isProbe(t), '既有探针族标题必须仍在族内：' + t);
  }
  // 样本任务的会话标题**有意不声明**：cohort.js 给它单独一档（SAMPLE_WHERE ⊂ 真实流量），
  // 改成探针会把"样本"档搬空且破坏"三子档加总 = 真实流量"的自检——那是改口径，不是本轮处置。
  assert.equal(isProbe('定时任务：RA35样本-真实调度路径'), false, '样本任务标题不进探针族（既有分档有意如此）');
});

test('有意不接的路径如实登记在册（不是漏项）', () => {
  // ① e2e-final.mjs / e2e-fx3.mjs（仓库根）：会建真会话，但 C-33 的 D2′ 审计②已裁决"历史证据，不修不删"；
  //    它们跑完会删会话 ⇒ 至多落"孤儿档"（ORPHAN_WHERE 已把孤儿排除在真实流量之外）。
  for (const rel of ['e2e-final.mjs', 'e2e-fx3.mjs']) {
    const src = read(rel);
    assert.ok(/(INSERT INTO conversations|\/api\/conversations', \{ method: 'POST')/.test(src), rel + ' 确实会建会话（这条登记的前提）');
    assert.equal(/probeTitle\(/.test(src), false, rel + ' 本轮有意不接（C-33 D2′ ②）；若接了，把这条改成"必须声明"，别只改代码');
  }
  // ② RA35 样本任务（scripts/schedule-test-task.mjs）：它的会话标题是「定时任务：<name>」，
  //    "不是探针"是该文件第 4–5 行写下的**登记过的口径**（走的是生产调度路径）。
  const sample = read('scripts/schedule-test-task.mjs');
  assert.ok(sample.includes('口径归属') && sample.includes('不是探针'), '样本任务"不是探针"的口径登记还在（被删了就要重新判）');
});
