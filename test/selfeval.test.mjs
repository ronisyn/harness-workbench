// test/selfeval.test.mjs —— 自进化三源采集与提案流水线夹具（v0.3 §7.1 ㉒㉓ + §0.4 判据/铁律）
//
// 为什么这样切：
//   · ***查库与成型分开***（collect.js 的设计）：成型是纯函数 ⇒ 假库就能测，不需要真 MySQL、CI 也能跑。
//   · 落库路径（write.js）用**记账假库**测：INSERT 语句与参数全记下来，既能测幂等，
//     又能反向锁"只允许写 extension_demands / evo_goals 这两张表"。
//   · 铁律用**负例**测（出现"自动提交/自动执行"必须被拒）——这是 v0.3 §0.4 风险②的机检。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSnapshot, ratio, numericStats, attributableBucket, batchIdOf, fingerprint,
  METRIC_STATUS,
} from '../server/selfeval/collect.js';
import {
  evaluatePriority, sortProposals, criteriaHit, isNewFeatureOnly, CRITERIA, CRITERIA_CN,
} from '../server/selfeval/priority.js';
import {
  buildProposals, checkIronLaw, hasAutomationIntent, rulesFromSnapshot,
  collectBenchmarkCandidates, parseFeedback, renderDemandContent, renderGoal, ROUTING,
  parseListDoc,
} from '../server/selfeval/propose.js';
import { writeProposal, assertWritableTable, findExisting, WRITABLE_TABLES } from '../server/selfeval/write.js';
import { REAL_WHERE, HUMAN_WHERE, SCHEDULED_WHERE, PROBE_WHERE, ORPHAN_WHERE } from '../server/cohort.js';

// ── 假库：按 SQL 特征回放行；记下所有写操作 ───────────────────────────────────────────────
function makeFakeDb(handler) {
  const writes = [];
  let seq = 1000;
  return {
    writes,
    async query(sql, params = []) {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
        writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return { insertId: ++seq, affectedRows: 1 };
      }
      const r = handler(sql, params);
      return Array.isArray(r) ? r : [];
    },
    // 存储接口那一半（2026-09-18）：`collectFailures` 已改走接口（`toolCalls.*`），所以这个假库
    // 也要提供"介质方法"。**值仍从同一个 handler 来**（把迁移前那条 SQL 的形状原样喂给 handler），
    // 所以快照里的数字一个字没变 —— 这本身就是"换实现不改调用方"的机检：同一批样本，
    // 走接口与走 SQL 必须给出同一份快照（`test/selfeval.test.mjs` 的断言逐条比的就是这个）。
    // 存储接口那一半（2026-09-18）：`collectLedger` 已改走接口（`audit.*`），所以假库也要提供这几个
    // "介质方法"。**值仍从同一个 handler 来**（把迁移前那几条 SQL 的形状喂给 handler），
    // 于是快照里的数字一个字没变 —— 同一批样本走接口与走 SQL 必须给出同一份快照。
    audit: {
      async countByActionPrefix(prefix, { days = null } = {}) {
        const r = handler(`SELECT action, COUNT(*) n FROM audit_log WHERE action LIKE '${prefix}%' AND created_at > NOW() - INTERVAL ? DAY GROUP BY action`, [days]);
        return Array.isArray(r) ? r : [];
      },
      async countByFirstToken(action, { days = null } = {}) {
        const r = handler(`SELECT SUBSTRING_INDEX(detail, ' ', 1) word, COUNT(*) n FROM audit_log WHERE action='${action}' GROUP BY word ORDER BY n DESC`, [days]);
        return Array.isArray(r) ? r : [];
      },
      async recentByActions({ limit = 20 } = {}) {
        const r = handler(`SELECT id, action, detail, conversation_id cid, created_at at FROM audit_log WHERE action IN ('prefix:invalidate','prefix:collapse') ORDER BY id DESC LIMIT ${limit}`, []);
        return Array.isArray(r) ? r : [];
      },
      async timeRange() {
        const r = handler('SELECT MIN(created_at) at, MAX(created_at) at2 FROM audit_log WHERE action LIKE \'prefix:%\'', []);
        return (Array.isArray(r) && r[0]) || null;
      },
    },
    toolCalls: {
      async failureTotals({ days = 7 } = {}) {
        const r = handler('SELECT COUNT(*) calls FROM tool_calls WHERE conversation_id > 0 AND created_at > NOW() - INTERVAL ? DAY', [days, days, days]);
        return (Array.isArray(r) && r[0]) || {};
      },
      async failByCode({ days = 7 } = {}) {
        const r = handler('SELECT COALESCE(error_code,"") code, COUNT(*) n, COUNT(DISTINCT tool_name) tools FROM tool_calls WHERE status="fail" AND conversation_id > 0 GROUP BY code ORDER BY n DESC', [days]);
        return Array.isArray(r) ? r : [];
      },
      async failByTool({ days = 7, limit = 20 } = {}) {
        const r = handler('SELECT tool_name tool, COALESCE(error_code,"") code, COUNT(*) n FROM tool_calls WHERE status="fail" AND conversation_id > 0 GROUP BY tool_name, code ORDER BY n DESC LIMIT 20', [days, limit]);
        return Array.isArray(r) ? r : [];
      },
    },
  };
}

/** 一个"能算出真数"的最小 selfeval 库（口径与真库同形，值是我们自己编的样本，不是真库读数） */
function sampleHandler() {
  // 档位判据**直接用真口径函数**（server/cohort.js）算出片段再比对：
  // 手写正则会在"REAL_WHERE 里面包含 PROBE_WHERE"这种包含关系上判错（真实踩过）。
  const COHORT_SQL = {
    probe: PROBE_WHERE('u'), orphan: ORPHAN_WHERE('u'), real: REAL_WHERE('u'),
    human: HUMAN_WHERE('u'), scheduled: SCHEDULED_WHERE('u'),
  };
  const ROWS = {
    real: { rounds: 40, convs: 2, hit: 900000, miss: 100000, cost: 12.5 },
    human: { rounds: 40, convs: 2, hit: 900000, miss: 100000, cost: 12.5 },
    scheduled: { rounds: 0, convs: 0, hit: 0, miss: 0, cost: 0 },
    probe: { rounds: 5, convs: 1, hit: 5000, miss: 5000, cost: 0.2 },
    orphan: { rounds: 0, convs: 0, hit: 0, miss: 0, cost: 0 },
  };
  // 按 SQL 里出现的档位片段定位是哪一档；REAL_WHERE 包含 PROBE/ORPHAN 片段，
  // 所以**先判真实流量的完整片段**，再退回更窄的档（顺序即特异性）。
  const cohortOf = (sql) => {
    // 人发起 = REAL ∧ ¬定时 ∧ ¬样本：先按它判（它的 SQL 里同时包含 REAL 与 SCHEDULED/样本片段）
    if (sql.includes(COHORT_SQL.human) && sql.includes('NOT (' + COHORT_SQL.scheduled + ')')) return 'human';
    if (sql.includes(COHORT_SQL.real)) return 'real';
    if (sql.includes(COHORT_SQL.scheduled) && sql.includes(COHORT_SQL.probe) && sql.includes(COHORT_SQL.orphan)) return 'scheduled';
    if (sql.includes(COHORT_SQL.probe)) return 'probe';
    if (sql.includes(COHORT_SQL.orphan)) return 'orphan';
    return null;
  };
  return (sql) => {
    const one = (o) => [o];
    if (/FROM usage_stats u/.test(sql) && /GROUP BY u\.conversation_id/.test(sql)) {
      return [{ cid: 184, title: '真实长会话', rounds: 40, cost: 12.5 }];
    }
    if (/FROM usage_stats u/.test(sql) && /COUNT\(\*\) rounds/.test(sql)) {
      const k = cohortOf(sql);
      return one(ROWS[k] || { rounds: 0, convs: 0, hit: 0, miss: 0, cost: 0 });
    }
    if (/FROM usage_stats u/.test(sql) && /COALESCE\(u\.cache_miss_tokens,0\) m/.test(sql)) {
      // 逐轮明细：真实档 40 轮（39 个 2000 + 1 个 9000），其余档给 5 轮
      const n = cohortOf(sql) === 'real' || cohortOf(sql) === 'human' ? 40 : 5;
      const rows = [];
      for (let i = 0; i < n; i++) rows.push({ m: i < n - 4 ? 2000 : 9000, h: 900000 / n, cost: 12.5 / n, cid: 184, rid: i === 0 ? 7 : null });
      // P95 要走最近秩：n=40 → 0 基 index 37，所以把**末 4 个**做成离群值（末 2 个会被 0.95 挡掉）
      return rows;
    }
    if (/FROM audit_log WHERE action LIKE 'prefix:%'/.test(sql) && /GROUP BY action/.test(sql)) {
      return [{ action: 'prefix:exempt', n: 12 }, { action: 'prefix:invalidate', n: 2 }, { action: 'prefix:collapse', n: 1 }];
    }
    if (/action='prefix:exempt' GROUP BY word/.test(sql)) {
      return [{ word: 'first-round', n: 9 }, { word: 'tool-face-changed', n: 3 }];
    }
    if (/action IN \('prefix:invalidate','prefix:collapse'\)/.test(sql)) {
      return [{ id: 9, action: 'prefix:invalidate', detail: 'first-diff-idx=3 core 12→11 round=4', cid: 184, at: '2026-09-16 03:00:00' }];
    }
    if (/SELECT MIN\(created_at\) at, MAX\(created_at\) at2 FROM audit_log/.test(sql)) return one({ at: '2026-09-15 01:00:00', at2: '2026-09-16 03:00:00' });
    if (/FROM tool_calls WHERE conversation_id > 0 AND created_at/.test(sql)) {
      return one({ calls: 500, fails: 25, probe_calls: 300, probe_fails: 139 });
    }
    if (/GROUP BY code ORDER BY n DESC/.test(sql)) return [{ code: 'deadline_exceeded', n: 15, tools: 2 }, { code: 'not_found', n: 10, tools: 3 }];
    if (/GROUP BY tool_name, code ORDER BY n DESC/.test(sql)) return [{ tool: 'run_command', code: 'deadline_exceeded', n: 15 }];
    if (/FROM shells WHERE eval_ref/.test(sql)) return [];          // 没有配金标的壳 → 准入前置不满足
    if (/action='canary:run'/.test(sql)) return [];
    if (/COUNT\(\*\) n FROM evo_goals/.test(sql)) return one({ n: 0 });
    if (/COUNT\(\*\) n FROM evo_goal_tasks/.test(sql)) return one({ n: 0 });
    if (/COUNT\(\*\) n FROM evo_memos/.test(sql)) return one({ n: 0 });
    if (/FROM extension_demands GROUP BY status/.test(sql)) return [];
    return [];
  };
}

/** 用假库组装一份快照（等价于 collectSnapshot，但 dbc 是假库、不碰真库、不加载真金标实现） */
async function snapshotFromFake(D, { at = new Date('2026-09-16T04:00:00Z'), days = 7, sources = [] } = {}) {
  const { collectUsage, collectLedger, collectFailures, collectCanary, collectPipeline } = await import('../server/selfeval/collect.js');
  const [usage, ledger, failures, canary, pipeline] = await Promise.all([
    collectUsage({ dbc: D, days }), collectLedger({ dbc: D, days }), collectFailures({ dbc: D, days }),
    // checks 是夹具缝：真金标实现会 import tools/manifest.js（并行改动期可能暂时语法不过），
    // 夹具不该被它牵连。这里给一个"跑得起来、但会如实报 skipped/error"的替身。
    collectCanary({ dbc: D, checks: async (ref) => (ref === 'code' ? { skipped: true, ref, reason: '夹具替身' } : { skipped: false, ref, total: 9, passed: 9 }) }),
    collectPipeline({ dbc: D }),
  ]);
  return buildSnapshot({ at, days, usage, ledger, failures, canary, pipeline, sources });
}

// ─────────────────────────────────────────────────────────────────────────────────────────
test('C1 快照成型（纯函数）：分档不合并、分母为 0 一律 null、缺数标 NO_DATA 而不是 0', async () => {
  const D = makeFakeDb(sampleHandler());
  const snap = await snapshotFromFake(D, { sources: [{ id: 'x', path: 'docs/x.md', exists: true, sha1_12: 'abc' }] });

  assert.equal(snap.kind, 'rw-selfeval-snapshot');
  assert.equal(snap.schema, 1);
  assert.equal(snap.window.days, 7);
  assert.equal(snap.batchId, 'selfeval-2026-09-16-7d');   // UTC+8 的 09-16 12:00

  const c = snap.metrics.c1c2.cohorts;
  // 真实流量：900000/(900000+100000)
  assert.equal(c.real.status, METRIC_STATUS.OK);
  assert.equal(c.real.rounds, 40);
  assert.equal(c.real.c1, 0.9);
  // C2 只报数：40 轮里 39 个 2000 + 1 个 9000 → 中位 2000、P95 9000
  assert.equal(c.real.c2Median, 2000);
  assert.equal(c.real.c2P95, 9000);
  // 定时任务档 0 轮 → NO_DATA（**不是** c1=0）
  assert.equal(c.scheduled.status, METRIC_STATUS.NO_DATA);
  assert.equal(c.scheduled.c1, undefined);
  assert.match(c.scheduled.note, /无数据/);
  // 探针单独一档，不得混进真实流量
  assert.equal(c.probe.rounds, 5);
  assert.equal(c.real.rounds + c.probe.rounds + c.orphan.rounds, 45, '分档加总必须等于各档之和（不合并隐藏）');

  // C3：真实流量 12.5 / 1 个 run / 1 个出现过的会话（逐轮明细里 cid 都是 184）
  assert.equal(snap.metrics.c3.runs, 1);
  assert.equal(snap.metrics.c3.conversations, 1);
  assert.equal(snap.metrics.c3.perRun, 12.5);
  assert.equal(snap.metrics.c3.topConversations[0].conversationId, 184);

  // C4/C5：机检口径 + 归因分桶（只报数）
  assert.equal(snap.metrics.c4c5.c4Invalidate, 2);
  assert.equal(snap.metrics.c4c5.c5Exempt, 12);
  assert.equal(snap.metrics.c4c5.c5Collapse, 1);
  assert.deepEqual(snap.metrics.c4c5.attributable, { 'first-round': 9, 'tool-face-changed': 3 });

  // 失败率：25/500
  assert.equal(snap.metrics.failures.failRate, 0.05);
  assert.equal(snap.metrics.failures.byCode[0].code, 'deadline_exceeded');

  // 金标：假库里没有配 eval_ref 的壳 ⇒ 这一档如实标 no-data（准入前置不满足），**不许当绿**
  assert.equal(snap.metrics.canary.status, METRIC_STATUS.NO_DATA);
  assert.equal(snap.metrics.canary.available, true);
  assert.deepEqual(snap.metrics.canary.shells, []);
  assert.deepEqual(snap.metrics.canary.failedShells, []);
  // 载体水位：全 0
  assert.equal(snap.metrics.pipeline.evoGoals, 0);
  assert.deepEqual(snap.metrics.pipeline.demandsByStatus, []);

  // 外部对标源：只记身份（半自动源，不是抓取）
  assert.equal(snap.benchmarkSources[0].path, 'docs/x.md');
  assert.deepEqual(snap.collectErrors, []);
});

test('C1b 分母为 0：失败率给 null 且 status=no-denominator（不许报成 0%）', async () => {
  const D = makeFakeDb((sql) => {
    if (/FROM tool_calls WHERE conversation_id > 0 AND created_at/.test(sql)) return [{ calls: 0, fails: 0, probe_calls: 0, probe_fails: 0 }];
    return sampleHandler()(sql);
  });
  const snap = await snapshotFromFake(D);
  assert.equal(snap.metrics.failures.status, METRIC_STATUS.NO_DENOMINATOR);
  assert.equal(snap.metrics.failures.failRate, null);
});

test('C1c 查库失败：如实进 collectErrors，不静默当 0', async () => {
  const D = makeFakeDb((sql) => {
    if (/FROM usage_stats u/.test(sql)) throw new Error('boom: usage_stats 不可达');
    return sampleHandler()(sql);
  });
  const snap = await snapshotFromFake(D);
  assert.ok(snap.collectErrors.some((e) => /boom/.test(e)), '采集失败必须出现在 collectErrors：' + JSON.stringify(snap.collectErrors));
  assert.equal(snap.metrics.c1c2.cohorts.real.status, METRIC_STATUS.NO_DATA);
});

test('C1d 纯函数小件：ratio / numericStats / attributableBucket / batchId / fingerprint', () => {
  assert.equal(ratio(1, 0), null, '分母 0 → null');
  assert.equal(ratio(0, 7), 0, '真 0 才是 0');
  assert.deepEqual(numericStats([]), { n: 0, min: null, median: null, p95: null, max: null });
  assert.deepEqual(numericStats([1, 2, 3, 4]), { n: 4, min: 1, median: 2.5, p95: 4, max: 4 });
  assert.equal(attributableBucket('tool-face-changed'), 'tool-face-changed');
  assert.equal(attributableBucket('something-new'), 'unknown');
  assert.equal(batchIdOf(new Date('2026-09-15T20:00:00Z'), 7), 'selfeval-2026-09-16-7d', '20:00Z 是北京时间次日 04:00');
  assert.equal(fingerprint('a', 'b'), fingerprint('a', 'b'));
  assert.notEqual(fingerprint('a', 'b'), fingerprint('a', 'c'));
});

test('C1e 金标跑不起来：连原因一起带出来（不许吞成一句"未取到"，也不许当绿）', async () => {
  const { collectCanary, buildSnapshot: BS } = await import('../server/selfeval/collect.js');
  const D = makeFakeDb((sql) => (/FROM shells WHERE eval_ref/.test(sql) ? [{ id: 1, skey: 'code', eval_ref: 'code' }] : []));
  const canary = await collectCanary({ dbc: D, checks: async () => { throw new Error("SyntaxError: Unexpected identifier '覆盖' (server/tools/manifest.js)"); } });
  const snap = BS({ at: new Date('2026-09-16T04:00:00Z'), days: 7, canary });
  assert.equal(snap.metrics.canary.status, METRIC_STATUS.NO_DATA, '壳跑不起来 ⇒ 准入前置不满足，不许报 ok');
  assert.equal(snap.metrics.canary.available, true, '壳取到了 ⇒ 金标实现本身是加载成功的，只是这个壳没跑成');
  assert.match(snap.metrics.canary.shells[0].error, /Unexpected identifier/, '错误原因必须留在读数里，否则排查只能靠猜');
  assert.equal(snap.metrics.canary.failedShells.length, 1);
  // 另一种失败：整个金标实现都 import 不进来
  const snap2 = BS({ at: new Date('2026-09-16T04:00:00Z'), days: 7, canary: { available: false, error: 'runGoldenChecks 不可用：manifest.js 语法错', shells: [] } });
  assert.equal(snap2.metrics.canary.status, METRIC_STATUS.NO_DATA);
  assert.match(snap2.metrics.canary.note, /manifest\.js 语法错/, '跑不起来的原因必须能看见');
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 金标集**身份**的一致性（2026-09-16 修的读数自相矛盾；v0.3 §0.4 准入前置 / §7.1 ㉔ 门禁要能认出"同一套金标"）
//
// 病灶（改前实测）：`collectCanary` 把 DB 行（字段名 `eval_ref`）直接喂给读 `s.ref` 的
// `goldenSetIdentities()` ⇒ 快照里 `metrics.canary.goldenSets` 恒为 `[{exists:false,count:0,sha1_12:null}]`，
// 而同一份报告顶层的 `golden`（`buildGoldenSection`，走 `goldenIdentityOf`）报 `code@7a7cc14e7251(9条)`——
// 两块读数指向同一批壳、同一套金标，却一个说"不存在"、一个说"9 条"：**自相矛盾**，门禁据此判"集合变了"。
test('金标集身份：快照 metrics.canary.goldenSets 与顶层 golden 指向同一套金标（ref/count/sha1 逐项一致）', async () => {
  const { collectCanary, buildSnapshot: BS, goldenSetIdentities } = await import('../server/selfeval/collect.js');
  const { goldenIdentityOf } = await import('../scripts/golden-report.mjs');
  const D = makeFakeDb((sql) => (/FROM shells WHERE eval_ref/.test(sql) ? [{ id: 1, skey: 'code', name: 'code', eval_ref: 'code' }] : []));
  const canary = await collectCanary({ dbc: D, checks: async () => ({ skipped: false, total: 9, passed: 9 }) });
  const snap = BS({ at: new Date('2026-09-16T04:00:00Z'), days: 7, canary });

  const sets = snap.metrics.canary.goldenSets || [];
  assert.equal(sets.length, 1, '配了 eval_ref 的壳 ⇒ 必须给出金标集身份（不是空数组）');
  const g = sets[0];
  assert.equal(g.ref, 'code', '身份里的 ref 必须是壳声明的金标集名（不是 undefined —— 那正是改前的病灶）');
  // 顶层 golden 那一块用的身份＝golden-report 的 goldenIdentityOf（同一实现、同一 eval/ 文件）：
  // 两边必须逐字段相同，否则"快照说 0 条、报告说 9 条"这种自相矛盾会再次出现。
  const top = goldenIdentityOf('code');
  assert.deepEqual({ ref: g.ref, exists: g.exists, count: g.count, sha1_12: g.sha1_12 },
    { ref: top.ref, exists: top.exists, count: top.count, sha1_12: top.sha1_12 },
    '快照里的金标集身份与顶层 golden 的身份必须是同一套（同 ref / 同 exists / 同 count / 同 sha1）');
  assert.equal(g.exists, true, 'eval/code.json 真实存在 ⇒ exists 必须为 true');
  assert.equal(g.count, 9, '当前金标集是 9 条（集合大小，不是成绩）');
  assert.match(String(g.sha1_12), /^[0-9a-f]{12}$/, '身份必须是条目集合的 sha1_12');

  // 反向锁：**传错字段**（把 DB 行原样传进去）就是这个 bug 的读数——夹具必须把它认成坏输入
  const wrong = goldenSetIdentities([{ id: 1, skey: 'code', eval_ref: 'code' }]);
  assert.deepEqual(wrong, [{ ref: undefined, exists: false, count: 0, sha1_12: null }],
    '这就是改前的读数（恒"金标不存在"）；改回错字段 ⇒ 上面那条断言必红');
});

// ─────────────────────────────────────────────────────────────────────────────────────────
test('C2 提案字段完整性：缺"验证方式"必拒；缺任何必填字段都不许落库', () => {
  const base = {
    id: 'x', source: 'selfeval', title: 't', basis: 'b', action: 'a',
    expectedBenefit: 'e', risk: 'r', verification: 'v', priority: { criteria: {} },
    kind: 'engine-improvement', route: { table: 'evo_goals' }, manualApprovalRequired: true,
  };
  assert.equal(checkIronLaw(base).ok, true, '齐全时必须通过：' + JSON.stringify(checkIronLaw(base)));
  for (const f of ['title', 'basis', 'action', 'expectedBenefit', 'risk', 'verification', 'priority']) {
    const bad = { ...base, [f]: '' };
    const r = checkIronLaw(bad);
    assert.equal(r.ok, false, `缺 ${f} 必须被拒`);
    assert.ok(r.missing.includes(f), `缺 ${f} 时必须报出 ${f}`);
  }
  // 严格模式：空数组也算缺
  assert.equal(checkIronLaw({ ...base, source: [] }).ok, false);
});

test('C2b 铁律负例：提案里出现"自动执行/自动提交"必须被拒（且与"禁止自动提交"区分开）', () => {
  // 正例：合规表述（在说"必须人工/禁止自动"）不许被误杀
  assert.equal(hasAutomationIntent('改完后由人工审批，禁止自动提交，需人工 merge').hit, false);
  assert.equal(hasAutomationIntent('本步骤不得自动执行，须人工点确认').hit, false);
  // 负例：要求机器自己动手
  assert.equal(hasAutomationIntent('改完直接 git commit 并 push').hit, true);
  assert.equal(hasAutomationIntent('让 agent 自动执行该脚本').hit, true);
  assert.equal(hasAutomationIntent('可以自动修改代码后自行落地').hit, true);

  const base = {
    id: 'x', source: 'selfeval', title: '优化成本', basis: 'v0.3 §0.3', action: '收窄上下文注入',
    expectedBenefit: '降低成本', risk: '误伤', verification: '跑 selfeval-collect 对比', priority: { criteria: {} },
    kind: 'engine-improvement', route: { table: 'evo_goals' }, manualApprovalRequired: true,
  };
  assert.equal(checkIronLaw(base).ok, true);
  // 三处埋雷，都要被逮住（不止 action 一处）
  for (const field of ['action', 'verification', 'risk']) {
    const r = checkIronLaw({ ...base, [field]: '改完后由 agent 自动执行并自行提交' });
    assert.equal(r.ok, false, `${field} 里的自动化意图必须被拒`);
    assert.ok(r.violations.some((v) => v.includes(field)), '违规要指到字段：' + JSON.stringify(r.violations));
  }
  // 少了"需人工审批"声明 → 拒（防自我放行）
  assert.equal(checkIronLaw({ ...base, manualApprovalRequired: false }).ok, false);
  assert.equal(checkIronLaw({ ...base, autoApply: true }).ok, false);
});

test('C2c 落库只允许两张表；不合格提案抛错且不产生任何写操作', async () => {
  const D = makeFakeDb(sampleHandler());
  assert.deepEqual([...WRITABLE_TABLES], ['extension_demands', 'evo_goals']);
  assert.throws(() => assertWritableTable('knowledge'), /拒绝写入表/);
  assert.throws(() => assertWritableTable('evo_goals; DROP TABLE x'), /拒绝写入表/);

  const bad = { title: '坏提案', source: 'selfeval', basis: 'b', action: '自动提交并 push', expectedBenefit: 'e', risk: 'r', verification: 'v', priority: {}, kind: 'engine-improvement', route: { table: 'evo_goals' }, manualApprovalRequired: true };
  await assert.rejects(() => writeProposal(bad, { dbc: D }), /拒绝落库/);
  assert.deepEqual(D.writes, [], '被拒的提案不许产生任何写操作');
});

// ─────────────────────────────────────────────────────────────────────────────────────────
test('C3 优先级按 §0.4 三条判据：无加权公式、判不出来如实标 unknown 并排到"判否"之前', () => {
  assert.deepEqual([...CRITERIA], ['c4-or-cost', 'delivery-speed', 'manual-effort']);
  const hit = criteriaHit('C4 失效次数从 2 降到 0');
  assert.deepEqual(hit, ['c4-or-cost']);
  assert.deepEqual(criteriaHit('减少人工介入，不用每天手动抄一遍'), ['manual-effort']);
  assert.deepEqual(criteriaHit(''), []);
  // 模糊词不入表（"自动"既能说少人工也能说多花钱，收了就是替人下结论）
  assert.deepEqual(criteriaHit('自动执行'), []);
  // 指标名要整词命中：中文文本里的 '介入，不用' 含子串 'C3'，includes 会凭空命中①（实测踩到）
  assert.deepEqual(criteriaHit('减少人工介入，不用每天手动抄一遍'), ['manual-effort']);

  const yes = evaluatePriority({ judged: { 'c4-or-cost': true, 'delivery-speed': false, 'manual-effort': false } });
  assert.deepEqual(yes.satisfied, ['c4-or-cost']);
  assert.deepEqual(yes.unknown, []);
  assert.equal(yes.needsHuman, false);

  // 有信号但机器没有实测值 ⇒ **不许猜 true**，并专门标 needsHuman（最容易被顺手判成"满足"的一类）
  const signalOnly = evaluatePriority({ evidence: '减少人工介入，不用每天手动抄一遍', expectedBenefit: '省事' });
  assert.deepEqual(signalOnly.satisfied, [], '只有文字信号时不许判成满足');
  assert.deepEqual(signalOnly.unknown, [...CRITERIA], '没有机器可核三值的判据要**如实说全**，不许粉饰成"已判"');
  assert.deepEqual(signalOnly.needsHumanCriteria, ['manual-effort'], '有信号的那条才需要人专门去看');
  assert.equal(signalOnly.needsHuman, true, '有信号无实测 ⇒ 必须有人在环里');
  assert.match(signalOnly.note, /有信号无实测/);
  // 一条信号都没有 ⇒ 不必惊动人（但仍是"未判"，排在"判否"之前）
  const silent = evaluatePriority({});
  assert.deepEqual(silent.unknown, [...CRITERIA]);
  assert.deepEqual(silent.needsHumanCriteria, []);
  assert.equal(silent.needsHuman, false);

  // 三条全判否：不算 unknown，也不许冒充满足
  const no = evaluatePriority({ judged: { 'c4-or-cost': false, 'delivery-speed': false, 'manual-effort': false } });
  assert.deepEqual(no.satisfied, []);
  assert.deepEqual(no.unknown, []);
  assert.equal(no.needsHuman, false);

  // 排序：满足判据的在前 → 判不了的其次 → 判否的最后；同级保持输入顺序（稳定，无隐性权重）
  const P = (id, pr) => ({ id, priority: pr });
  const sorted = sortProposals([
    P('all-false', no),
    P('unknown', signalOnly),
    P('yes-cost', yes),
    P('yes-cost-2', yes),
  ]);
  assert.deepEqual(sorted.map((x) => x.id), ['yes-cost', 'yes-cost-2', 'unknown', 'all-false']);
  assert.deepEqual(sortProposals([P('a', yes)]).map((x) => x.id), ['a'], '不改入参/不改顺序');

  // "加新功能"标记：没有一条判据支持时才标
  assert.equal(isNewFeatureOnly({ title: '新增模型市场页', priority: no, expectedBenefit: '加新功能' }), true);
  assert.equal(isNewFeatureOnly({ title: '新增模型市场页', priority: yes, expectedBenefit: '加新功能' }), false);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
test('C4 三源 → 提案：字段齐、去向按规则、自我体检源真的按快照触发（含"不可判"与"铁律在位"两条）', async () => {
  const D = makeFakeDb(sampleHandler());
  const snap = await snapshotFromFake(D);
  const rules = rulesFromSnapshot(snap).map((r) => r.rule);
  // 样本快照的触发条件：C4=2 次失效（R2）、有失败码（R3）、成本集中（R4）、无金标壳（R5）、载体空（R6）
  assert.ok(rules.includes('R2-c4-invalidate'), '有 C4 失效必须产提案：' + rules.join(','));
  assert.ok(rules.includes('R3-failure-code'), '有失败码必须产提案：' + rules.join(','));
  assert.ok(rules.includes('R4-cost-concentration'), '成本集中必须产提案：' + rules.join(','));
  assert.ok(rules.includes('R5-canary-not-in-place'), '金标不在位必须产提案（准入前置）：' + rules.join(','));
  assert.ok(rules.includes('R6-pipeline-empty'), '载体空转必须产提案：' + rules.join(','));
  assert.ok(!rules.includes('R1-unjudgeable-window'), '真实流量 40 轮 ≥30 ⇒ 不产"不可判"提案');

  const out = buildProposals({ snapshot: snap });
  assert.ok(out.proposals.length >= 5);
  for (const p of out.proposals) {
    assert.equal(checkIronLaw(p).ok, true, '产出的提案必须自检通过：' + p.title + ' → ' + JSON.stringify(checkIronLaw(p).violations));
    assert.equal(p.manualApprovalRequired, true, '每条提案都必须声明需人工审批');
    assert.ok(p.verification.length > 10, '验证方式必须能执行，不是一句"验证一下"：' + p.title);
    assert.equal(p.route.table, ROUTING.selfeval.table);
    assert.ok(p.locator, '缺"涉及位置"时必须显式写"未定位"而不是空');
  }
  // 依据必须能指到 v0.3 条款或实测数据
  for (const p of out.proposals) {
    assert.match(p.basis, /v0\.3|§/);
    assert.match(p.basis, /实测|＋/);
  }
  // 优先级判不出来的一条（R5 的金标读数没有实测收益）必须带 needsHuman
  assert.ok(out.proposals.some((p) => p.priority.needsHuman), '应有需要人确认的提案');
});

test('C4b 三源齐全时：外部对标项**逐条**进 extension_demands，业务反馈逐条进同表', async () => {
  const D = makeFakeDb(sampleHandler());
  const snap = await snapshotFromFake(D);
  const out = buildProposals({
    snapshot: snap,
    benchmark: { items: [
      { sourceId: 'cli-borrow-list', docPath: 'docs/Codex与主流CLI-机制借鉴清单-v1.md', title: '多模型交叉验证', originLine: '4. **⬜ 多模型交叉验证（可选）**', adaptability: '未判（需人看源码/条款后逐条给结论）' },
      { sourceId: 'dsh-cache-report', docPath: 'docs/dsh-cache-hit-99.8-report.md', title: '指标诚实性', gain: '收益中、成本极低', originLine: '5. **指标诚实性**：…' },
    ], errors: [] },
    feedback: { items: [{ title: '日报要手工抄一遍才能发', origin: '运营岗' }], errors: [] },
  });
  const bench = out.proposals.filter((p) => p.source === 'benchmark');
  assert.equal(bench.length, 2, '对标候选逐条成案');
  assert.equal(bench[0].route.table, 'extension_demands');
  assert.equal(bench[0].kind, 'manual', 'kind 必须在表注释枚举 hard|soft|manual 内');
  assert.match(bench[1].expectedBenefit, /收益中、成本极低/);
  assert.match(bench[0].action, /未判适配性前不得立项/);

  const fb = out.proposals.filter((p) => p.source === 'feedback');
  assert.equal(fb.length, 1);
  assert.equal(fb[0].route.table, 'extension_demands');
  assert.match(fb[0].basis, /不采岗位绩效与痛点/, '要把"现有 intake 不采绩效"如实写进依据');

  // 渲染进库文本：必填项一个都不许丢
  const txt = renderDemandContent(bench[0]);
  for (const k of ['【批次】', '【来源】', '【指纹】', '【依据】', '【建议改动】', '【预期收益】', '【风险】', '【验证方式】', '【优先级】', '【人工审批】']) {
    assert.ok(txt.includes(k), '需求文本缺 ' + k);
  }
  assert.ok(txt.length <= 2000, 'content 必须落在 TEXT 的 2000 字口径内（与 index.js:2643 同口径）');
  const goal = renderGoal(out.proposals.find((p) => p.source === 'selfeval'));
  assert.ok(goal.name.length <= 200, 'evo_goals.name 是 VARCHAR(200)');
  assert.ok(goal.descr.length <= 1000, 'evo_goals.descr 是 VARCHAR(1000)');
  assert.ok(goal.descr.includes('【验证方式】'));
});

test('C4c 外部对标输入：解析真文档（过滤"不做"项 + 同文件去重），读不到时如实报错', () => {
  const r = collectBenchmarkCandidates({ root: process.cwd(), sources: [{ id: 'missing', path: 'docs/__不存在__.md', kind: 'list' }] });
  assert.equal(r.items.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /读不到/);
  // 同文件**逐字重复**必须合并成一条（真文档里 §2 与 §4 的复述措辞不同，见下面那条边界）
  const dupDoc = [
    '## 2. 差距',
    '3. **⬜ 多模型交叉验证（可选）**（主会话拍板：延后）',
    '## 4. 执行顺序',
    '4. ⬜ 多模型交叉验证（可选）—— 见 §4 标注',
    '6. **⬜ watch 文件变更广播**：服务器版价值低，不做',
  ].join('\n');
  assert.deepEqual(parseListDoc(dupDoc).map((x) => x.title.length > 0), [true], '逐字重复的项必须合并成 1 条');
  assert.equal(parseListDoc(dupDoc).length, 1);
  // 真文件：历史清单里 ⬜ 项有两处（§2 一条、§4 又复述一条，措辞不同：多模型/双模型交叉验证）。
  // 同文件**同名**去重能把"逐字重复"合成一条，但**语义同一项换个措辞**它认不出来——
  // 这是有意的取舍（不做模糊聚类，宁可交给人一眼看出重复，也不自动合并语义）。夹具把这条边界也锁住。
  const real = collectBenchmarkCandidates({ root: process.cwd(), sources: [{ id: 'cli-borrow-list', path: 'docs/Codex与主流CLI-机制借鉴清单-v1.md', kind: 'list' }] });
  assert.equal(real.errors.length, 0);
  assert.equal(real.items.length, 2, '真文档当前有 2 条 ⬜ 候选（含一处措辞不同但语义重复）：' + JSON.stringify(real.items.map((i) => i.title)));
  assert.ok(real.items.some((i) => /多模型交叉验证/.test(i.title)) && real.items.some((i) => /双模型交叉验证/.test(i.title)));
  assert.ok(!real.items.some((i) => /watch 文件变更广播/.test(i.title)), '文档自己写着"不做"的项不许进候选');
  // 实测报告的"可移植做法"小节能解析出编号条目（5 条，去重后仍 5 条）
  const rep = collectBenchmarkCandidates({ root: process.cwd(), sources: [{ id: 'dsh-cache-report', path: 'docs/dsh-cache-hit-99.8-report.md', kind: 'report' }] });
  assert.equal(rep.items.length, 5, '应解析出 §5 的 5 条做法：' + JSON.stringify(rep.items.map((i) => i.title)));
  assert.ok(rep.items.some((i) => /动态内容从 system prompt/.test(i.title)));
  assert.ok(rep.items[0].gain, '收益/成本标注要带上：' + JSON.stringify(rep.items[0]));
});

test('C4d 业务反馈解析：逐条 + 来源，忽略注释行', () => {
  const items = parseFeedback('# 注释\n\n- 日报要手工抄一遍才能发 | 运营岗\n2. 客户名单导出后还要手工合并【销售岗】\n');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '日报要手工抄一遍才能发');
  assert.equal(items[0].origin, '运营岗');
  assert.equal(items[1].origin, '销售岗');
});

// ─────────────────────────────────────────────────────────────────────────────────────────
test('C5 幂等：同批次跑两次，只落一次（第二次走 skipped，不再 INSERT）', async () => {
  // 第一遍：两张表都查不到指纹 → 各自 INSERT 一次
  const seen = new Map();
  const D1 = makeFakeDb((sql, params) => {
    if (/FROM extension_demands WHERE content LIKE/.test(sql) || /FROM evo_goals WHERE descr LIKE/.test(sql)) return seen.get(params[0]) || [];
    return sampleHandler()(sql);
  });
  // 手工造两条：一条进 demands、一条进 goals
  const mk = (route, id) => ({
    id, fingerprint: 'fp' + id, source: 'selfeval', title: '提案' + id, basis: 'v0.3 §0.4＋实测', action: '改一处',
    expectedBenefit: '降成本', risk: '误伤', verification: '复跑 selfeval-collect 对比',
    priority: { criteria: {}, satisfied: [], unknown: [], needsHuman: true, note: '' },
    kind: route === 'evo_goals' ? 'engine-improvement' : 'manual', route: { table: route }, manualApprovalRequired: true,
  });
  const a = mk('extension_demands', 1), b = mk('evo_goals', 2);
  const r1a = await writeProposal(a, { dbc: D1, accountId: 1 });
  const r1b = await writeProposal(b, { dbc: D1, accountId: 1 });
  assert.equal(r1a.action, 'created');
  assert.equal(r1b.action, 'created');

  // 把第一次写入的内容标记成"库里已有"，第二遍必须全部跳过
  for (const w of D1.writes) seen.set('%' + String(w.params[w.params.length - 1]).split('%')[1] + '%', [{ id: 7, status: '待审' }]);
  const D2 = makeFakeDb((sql, params) => (/LIKE/.test(sql) ? [{ id: 7, status: '待审' }] : sampleHandler()(sql)));
  const r2a = await writeProposal(a, { dbc: D2, accountId: 1 });
  const r2b = await writeProposal(b, { dbc: D2, accountId: 1 });
  assert.equal(r2a.action, 'skipped-duplicate');
  assert.equal(r2b.action, 'skipped-duplicate');
  assert.deepEqual(D2.writes.filter((w) => /^INSERT/.test(w.sql)), [], '第二次不许再 INSERT');

  // 幂等的判据就是指纹：同批次同一条 → 同指纹；不同批次 / 不同条 → 不同指纹
  assert.equal(fingerprint('selfeval-2026-09-16-7d', 'selfeval', 'R2-c4-invalidate'), fingerprint('selfeval-2026-09-16-7d', 'selfeval', 'R2-c4-invalidate'));
  assert.notEqual(fingerprint('selfeval-2026-09-16-7d', 'selfeval', 'R2-c4-invalidate'), fingerprint('selfeval-2026-09-17-7d', 'selfeval', 'R2-c4-invalidate'));
});

test('C5b 写入表名白名单：write.js 源码里除了这两张表不许出现别的写目标', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server/selfeval/write.js', import.meta.url), 'utf8');
  const inserts = [...src.matchAll(/INSERT INTO\s+([a-z_]+)/gi)].map((m) => m[1]);
  assert.ok(inserts.length >= 2, 'write.js 里应当只有两处 INSERT');
  for (const t of inserts) assert.ok(WRITABLE_TABLES.includes(t), `write.js 出现了白名单外的写目标：${t}`);
  // 反向锁：整个 selfeval 目录不许出现 UPDATE/DELETE/git 提交
  const dir = new URL('../server/selfeval/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/\b(UPDATE|DELETE FROM)\s+[a-z_]+/i.test(s.replace(/\/\/.*$/gm, '')), `${f} 不得出现 UPDATE/DELETE（引擎不许自动改数据）`);
    assert.ok(!/(child_process|execSync|spawnSync)/.test(s), `${f} 不得有子进程能力（防"自动提交"从后门进来）`);
  }
});
