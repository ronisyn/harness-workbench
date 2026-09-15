// test/golden-gate.test.mjs —— ⑲「金标随包自检」的门禁判定与结果导出（夹具，**不碰真库**）
//
// 为什么锁这几条：
//   ① **判据就是 `passed === total`**（0/1，照抄 server/canary.js 的既有语义）——夹具在这里挡住"哪天顺手
//      加一条通过率阈值"：v0.3 §7.1 ㉔「指标回归门禁」是另一件事，还没做（不发明阈值）。
//   ② **skipped 不算通过、也不算失败**：跑不起来（金标文件缺失/壳没配 eval.goldenSetRef）必须如实出现在
//      结果里，既不阻断发布，也不许被折进 passed —— 否则"金标没跑"会被读成"金标全绿"。
//   ③ 这两件事**必须接进 release/CI/安装脚本**：只"能跑"不是门禁（v0.3 §0.4 M3 准入前置 / §4.8）。
//      用静态断言锁住接线（锚点式机检的既有做法），谁把这一步删了，夹具立刻红。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  goldenGatePass, goldenGateJudged, goldenGateLine, runGoldenGate,
  writeGoldenReport, GOLDEN_REPORT_FORMAT, GOLDEN_REPORT_VERSION,
} from '../scripts/golden-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const shell = (over = {}) => ({ shell: 'code', ref: 'code', skipped: false, passed: 9, total: 9, cases: [], ...over });
const skipped = (over = {}) => ({ shell: 'default', ref: null, skipped: true, reason: '未配置 eval.goldenSetRef', ...over });

// ── 假库：只认 runGoldenGate 发出的两条语句（照 test/eventlog-archive.test.mjs 的风格按 SQL 分派）────
function fakeDb({ shells = [], tools = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/FROM shells\b/.test(sql)) return shells.map((s) => ({ tools_preset: 'standard', intent_rules: null, ...s }));
      if (/FROM shell_tools\b/.test(sql)) return tools.filter((t) => t.shell_id === params[0]);
      return [];
    },
  };
}

// ---------------- ① 判定：passed===total 才放行（三种组合 + 负例） ----------------
test('全绿 ⇒ 放行；有一条没过 ⇒ 阻断（判据是 passed===total，不是某个百分比）', () => {
  assert.equal(goldenGatePass({ shells: [shell()] }), true, '9/9 必须放行');
  assert.equal(goldenGatePass({ shells: [shell({ passed: 8, total: 9 })] }), false, '8/9 必须阻断');
  assert.equal(goldenGatePass({ shells: [shell({ passed: 0, total: 9 })] }), false);
  // 多壳：只要有一个红，整体就红（门禁是"与"，不是"多数通过"）
  assert.equal(goldenGatePass({ shells: [shell(), shell({ shell: 'other', passed: 3, total: 4 })] }), false);
  assert.equal(goldenGateJudged({ shells: [shell()] }), true);
});

test('skipped 不算通过也不算失败：不阻断，但必须出现在结果里且不得折进 passed', () => {
  // 只有 skipped（金标文件缺失/壳没配）⇒ 不阻断 —— 阻断会让 CI（无 MySQL）与客户机（壳还没导入）永远红
  assert.equal(goldenGatePass({ shells: [skipped()] }), true);
  assert.equal(goldenGateJudged({ shells: [skipped()] }), false, '一条都没判定过 = 未判定，不能说"通过"');
  assert.match(goldenGateLine({ shells: [skipped()] }), /未判定|skipped/, '输出必须说清"没判定"及原因');
  assert.match(goldenGateLine({ shells: [skipped()] }), /未配置 eval.goldenSetRef/);
  // 混着来：绿的 + 跳过的 ⇒ 判定通过，但计数只算真正判过的那条（9/9，不是 9/9+0）
  const mixed = { shells: [skipped(), shell()] };
  assert.equal(goldenGatePass(mixed), true);
  assert.equal(goldenGateJudged(mixed), true);
  assert.match(goldenGateLine(mixed), /passed=9\/9/);
  assert.match(goldenGateLine(mixed), /1 个 skipped/);
  // 混着来但红的那条 ⇒ 阻断（skipped 顶不了红）
  assert.equal(goldenGatePass({ shells: [skipped(), shell({ passed: 1, total: 9 })] }), false);
  // 负例：0 条壳（空报告）不是通过，是"没判过"
  assert.equal(goldenGatePass({ shells: [] }), true);
  assert.equal(goldenGateJudged({ shells: [] }), false);
  assert.match(goldenGateLine({ shells: [] }), /未判定/);
});

// ---------------- ② 取壳：与 canary:run 同口径（壳行 + shell_tools 三态） ----------------
test('取壳口径与线上 canary:run 一致：壳行给词表/presetBase，shell_tools 给三态', async () => {
  const dbc = fakeDb({
    shells: [{ id: 2, skey: 'code', name: '代码壳', eval_ref: 'code' }],
    tools: [{ shell_id: 2, tool_name: 'run_command', mode: 'force_off' }],
  });
  const r = await runGoldenGate({ dbc });
  assert.equal(r.format, GOLDEN_REPORT_FORMAT);
  assert.equal(r.formatVersion, GOLDEN_REPORT_VERSION);
  assert.match(r.at, /^\d{4}-\d{2}-\d{2}T/, '结果必须带时间戳（前后对比 / 定位"这是哪一次"）');
  const code = r.shells.find((s) => s.shell === 'code');
  assert.equal(code.skipped, false);
  assert.equal(code.passed, 9);
  assert.equal(code.total, 9);
  assert.equal(code.cases.length, 9, '每条断言都要有明细（判红时要能直接看到是哪一条错）');
  assert.deepEqual(Object.keys(code.cases[0]), ['i', 'q', 'pass'], '过的条目只留 i/q/pass（不塞 want/got 噪声）');
  assert.equal(code.cases.every((c) => c.pass === true), true);
  assert.equal(goldenGatePass(r), true);
  // ⑥ 没有 eval_ref 的壳：如实 skipped，而不是被跳过不记
  const r2 = await runGoldenGate({ dbc: fakeDb({ shells: [{ id: 1, skey: 'default', eval_ref: null }] }) });
  assert.equal(r2.shells.length, 1);
  assert.equal(r2.shells[0].skipped, true);
  assert.match(r2.shells[0].reason, /eval\.goldenSetRef/);
  assert.equal(goldenGateJudged(r2), false);
});

test('跑不起来 ≠ 通过：金标文件缺失 ⇒ skipped（原因写清），不抛错、不假装全绿', async () => {
  const dbc = fakeDb({ shells: [{ id: 2, skey: 'code', eval_ref: '不存在的金标集-xyz' }] });
  const r = await runGoldenGate({ dbc });
  assert.equal(r.shells[0].skipped, true);
  assert.equal(r.shells[0].ref, '不存在的金标集-xyz');
  assert.match(r.shells[0].reason, /缺失|为空/);
  assert.equal('passed' in r.shells[0], false, 'skipped 的壳不许带 passed 字段（带了就会被读成"过了 0 条"）');
  assert.equal(goldenGatePass(r), true, '不阻断，但结论是"未判定"');
  assert.equal(goldenGateJudged(r), false);
  // --only 点了不存在的壳：如实记一行 skipped，而不是静默返回空（静默会让 `--only 打错字` 显示全绿）
  const r2 = await runGoldenGate({ dbc: fakeDb({ shells: [] }), only: ['typo-shell'] });
  assert.equal(r2.shells.length, 1);
  assert.equal(r2.shells[0].skipped, true);
  assert.match(r2.shells[0].reason, /不存在|未启用/);
  assert.equal(goldenGateJudged(r2), false);
});

// ---------------- ③ 与 canary.js 的判据同源（不另立一套） ----------------
test('门禁复用的是 canary.js 的断言实现，判据没有第二处', () => {
  const src = read('scripts/golden-report.mjs');
  assert.match(src, /from '\.\.\/server\/canary\.js'/, '金标断言必须复用 server/canary.js（随包的那一份）');
  assert.match(src, /runGoldenChecks\(/, '跑的是 canary 的 runGoldenChecks');
  // 判据只能有一条，且必须落在 goldenGatePass 的**函数体**里：注释里可以讨论阈值（本轮刻意不做），
  // 但判定分支里不许出现任何别的比较 —— 这是"不发明阈值"唯一能机检的形状。
  const body = src.slice(src.indexOf('export function goldenGatePass'), src.indexOf('/** 门禁是否'));
  const cmps = body.match(/(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*\s*(?:===|!==|>=|<=|>|<)\s*(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*/g) || [];
  assert.deepEqual(cmps, ['s.passed === s.total'], '判定分支里只许有 passed===total 这一条比较，实际：' + cmps.join(' / '));
  // 金标集本身是随包的（git 管理），不是运行时产物
  assert.ok(fs.existsSync(path.join(ROOT, 'eval', 'code.json')), 'eval/code.json 必须随仓库在（金标随包）');
  assert.match(read('shellpacks/code/pack.json'), /"goldenSetRef":\s*"code"/, '壳包要声明它用哪套金标（eval.goldenSetRef）');
});

// ---------------- ④ 结果可导出（v0.3 §4.8「评测结果可导出」） ----------------
test('结果写成结构化文件：自描述 + 逐壳 passed/total/skipped/cases/at', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-golden-'));
  try {
    const out = path.join(dir, 'sub', 'golden-report.json'); // 父目录不存在也要能建
    const report = { format: GOLDEN_REPORT_FORMAT, formatVersion: GOLDEN_REPORT_VERSION, at: '2026-09-16T00:00:00Z', shells: [shell({ passed: 8, total: 9, cases: [{ i: 3, q: '把生产库清空', pass: false, want: '意图=act-high', got: '意图=act' }] })] };
    const p = writeGoldenReport(report, out);
    assert.equal(p, path.resolve(out));
    const back = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepEqual(back, report, '写出来必须能原样读回（CI 拿它当产物、给人看、给 ㉔ 当输入）');
    assert.equal(back.shells[0].cases[0].pass, false);
    assert.equal(back.shells[0].cases[0].want, '意图=act-high', '判红的条目必须带期望值');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // 默认落点必须是 tmp/（已 gitignore）：门禁写盘不许把工作区搞脏 —— release.mjs 第 1 步就查工作区干净
  assert.match(read('scripts/golden-report.mjs'), /'tmp', 'golden-report\.json'/);
  assert.match(read('.gitignore'), /^tmp\/$/m);
});

// ---------------- ⑤ 接线：三处门禁调用点必须在位（v0.3 §0.4 M3 准入前置 / §4.8） ----------------
test('接线在位：release 阻断、CI 跑一步（无库如实 skip）、安装脚本自检带金标', () => {
  const rel = read('scripts/release.mjs');
  assert.match(rel, /golden-report\.mjs/, 'release.mjs 必须跑金标');
  assert.match(rel, /goldenGatePass/, 'release.mjs 必须用门禁判定（passed===total）');
  assert.match(rel, /goldenGateJudged/, 'release.mjs 必须区分"判过"与"如实跳过"');
  // 门禁名是单一出处（GOLDEN_STEP 常量）：判不过时它会进 fail 列表 ⇒ 退出码 1 ⇒ 阻断发布
  const name = /const GOLDEN_STEP = '([^']+)'/.exec(rel);
  assert.ok(name, 'release.mjs 必须把门禁名写成常量（夹具据此断言它真在阻断路径上）');
  assert.match(rel, /step\(GOLDEN_STEP, golden\.goldenGatePass\(goldenReport\)/, '判定结果必须交给 step(...)');
  assert.match(rel, /fail\)[\s\S]{0,40}?\.push\(name\)/, 'step 的失败分支要进 fail 列表（既有机制：`(cond ? ok : fail).push(name)`）');
  assert.match(read('scripts/release.mjs'), /if \(fail\.length\)[\s\S]{0,120}process\.exit\(1\)/, 'fail 非空即退出码 1');
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /golden-report\.mjs/, 'CI 必须跑同一步（同一步骤定义在脚本里，CI 不另写一套）');
  assert.match(ci, /upload-artifact/, 'CI 要把金标结果当产物保存（§4.8 结果可导出）');
  assert.match(ci, /tmp\/golden-report\.json/, 'CI 产物路径要与脚本默认落点一致');
  const ps1 = read('scripts/windows/install-service.ps1');
  assert.match(ps1, /golden-report\.mjs/, '自助安装包必须跑金标（⑲：随包自检）');
  assert.match(ps1, /SkipGolden|SkipSelfCheck/, '装机既然能跳过自检，金标也要能跳（客户机没导入壳时不至于阻断装机）');
});
