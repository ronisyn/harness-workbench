// test/prefix-attribution.test.mjs - 夹具：前缀归因脚本的**判据**（纯函数）与输出形状
//
// 背景（2026-09-16 实测）：scripts/prefix-attribution.mjs 把"该会话里第一次见到这一轮"判成"真·首见"，
// 于是一次性会话碰到**全新纪元**时，输出是"真·首见、换纪元 0 次"——**换纪元这件事被统计口径吃掉了**
// （近 14 天窗口 8 条冷启动全是"真·首见"，库里同期 prefix:epoch-change 账本有 52 条）。
// 处置：**不改三态口径**，而是把"这一轮到底能不能机检判断是否跨纪元"如实打出来
// （逐轮一列可判性 + 汇总"可判轮数 / 不可判轮数"），口径沿用 scripts/c1c2-forensics.mjs 的 nofp
// （指纹列不全 ⇒ 机检判不了，不拿"未命中大"倒推成因）。
//
// 本夹具只测纯函数（**不连库**，不跑脚本主体）：判据的唯一出处是 scripts/prefix-attribution-lib.mjs，
// 也就是脚本真正在跑的那份。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, judgeability, sessionAnchor, summarizeJudgeability, CATEGORIES } from '../scripts/prefix-attribution-lib.mjs';

/** 一行 usage_stats 的默认形状 = "一次性会话、无指纹"那一档，按需覆盖 */
const row = (o = {}) => ({ sys: null, tools: null, prev_tools: null, seen_before: 0, gap_since_prev: null, ...o });

test('可判性①：本行带指纹 ⇒ 可判（sys / tools 任一即可）', () => {
  const j = judgeability(row({ sys: 'c75ecfc01bff', tools: '6a24d271ae51' }), 0);
  assert.equal(j.label, '可判');
  assert.equal(j.judgeable, true);
  assert.equal(j.basis, 'fingerprint');
  assert.equal(j.cell, '可判/指纹');
  assert.equal(judgeability(row({ sys: 'c75ecfc01bff' }), 0).label, '可判', '只有 sys 也算有指纹');
  assert.equal(judgeability(row({ tools: '6a24d271ae51' }), 0).label, '可判', '只有 tools 也算有指纹');
  assert.equal(judgeability(row({ sys: '', tools: '' }), 0).label, '不可判', '空串按"无指纹"算（库里只可能是 NULL 或哈希）');
});

test('可判性①：本行无指纹 ⇒ 不可判；但账本有 prefix:epoch-change 时按账本判为可判', () => {
  const j = judgeability(row(), 0);
  assert.equal(j.label, '不可判');
  assert.equal(j.judgeable, false);
  assert.equal(j.basis, 'none');
  assert.equal(j.cell, '不可判');
  assert.match(j.why, /机检判不了/);
  assert.match(j.why, /不拿/, '不可判的理由里必须写明"不倒推成因"');
  const j2 = judgeability(row(), 52);
  assert.equal(j2.label, '可判');
  assert.equal(j2.basis, 'epoch-ledger');
  assert.equal(j2.cell, '可判/账本');
});

test('可判性②：汇总给出可判轮数 / 不可判轮数两个计数', () => {
  const rows = [
    row({ sys: 'a1', tools: 'b1' }),
    row({ sys: 'a2', tools: 'b2' }),
    row(), // 无指纹，且账本为空 ⇒ 不可判
  ];
  const s = summarizeJudgeability(rows, 0);
  assert.equal(s.total, 3);
  assert.equal(s.judgeable, 2);
  assert.equal(s.unjudgeable, 1);
  assert.equal(s.judgeable + s.unjudgeable, s.total, '两个计数必须覆盖全部轮次');
  assert.deepEqual(s.byBasis, { fingerprint: 2, 'epoch-ledger': 0, none: 1 });
  const s2 = summarizeJudgeability(rows, 7); // 账本非空 ⇒ 无指纹那轮也有账本锚点
  assert.equal(s2.judgeable, 3);
  assert.equal(s2.unjudgeable, 0);
  const s3 = summarizeJudgeability([], 7); // 空窗口：计数为 0，不抛
  assert.deepEqual([s3.total, s3.judgeable, s3.unjudgeable], [0, 0, 0]);
});

test('类别回归锁③：三枚类别字符串是既有口径，不许改名；判据优先级也不许变', () => {
  assert.deepEqual(CATEGORIES, ['真·首见', '换纪元', '久未用']);
  assert.equal(classify(row({ seen_before: 0 })), '真·首见');
  assert.equal(classify(row({ seen_before: 3, prev_tools: 'old', tools: 'new' })), '换纪元');
  assert.equal(classify(row({ seen_before: 3, prev_tools: 'same', tools: 'same' })), '久未用');
  // 既有优先级（**本次不许改**）：本会话首见这一枚指纹时，哪怕上一轮是另一枚，也仍然判"真·首见"
  // —— 这正是"换纪元被统计口径吃掉"的机制所在，夹具把它钉住，免得日后有人顺手"修"了类别定义。
  assert.equal(classify(row({ seen_before: 0, prev_tools: 'old', tools: 'new' })), '真·首见');
  // 上一轮没有指纹时，不得凭空判成"换纪元"
  assert.equal(classify(row({ seen_before: 1, prev_tools: null, tools: 'new' })), '久未用');
});

test('会话内可比性：只用已取到的字段判，0 秒间隔不算"没有前序轮次"', () => {
  assert.equal(sessionAnchor(row()).kind, 'no-prior-round', 'gap_since_prev=null ⇒ 本会话此前没有轮次');
  assert.equal(sessionAnchor(row({ gap_since_prev: 0 })).kind, 'prior-round-no-fingerprint', '0 秒是"有前序轮次"');
  assert.equal(sessionAnchor(row({ gap_since_prev: 900 })).kind, 'prior-round-no-fingerprint');
  assert.equal(sessionAnchor(row({ gap_since_prev: 900, prev_tools: 'x' })).kind, 'prior-fingerprint');
});

// 真实读数形状（2026-09-16 从库里读到的窗口，冻结在夹具里；库里数据以后怎么变都不影响本夹具）：
// 近 14 天、单轮未命中 > 3000、带指纹的 8 条冷启动 —— 全部"真·首见"，且**会话内没有可比对的前序指纹**。
const WINDOW_SNAPSHOT = [
  { id: 6056, cid: 773, sys: 'c75ecfc01bff', tools: '6a24d271ae51' },
  { id: 6025, cid: 767, sys: 'ab95c2bfb295', tools: '6a24d271ae51' },
  { id: 6016, cid: 764, sys: '7560386bed5d', tools: '6a24d271ae51' },
  { id: 6006, cid: 760, sys: '2a63a9da1786', tools: '83435ba22c86' },
  { id: 5968, cid: 738, sys: '621fcdec59ed', tools: 'a4010e7cb708' },
  { id: 5931, cid: 728, sys: '8f41e24023c9', tools: 'b0a8a611a1d9' },
  { id: 5883, cid: 714, sys: '8f41e24023c9', tools: '40208f70b0c9' },
  { id: 5813, cid: 697, sys: '8f41e24023c9', tools: '5efe5b8d69e1' },
].map((r) => row(r));

test('真实读数形状：8 条全是"真·首见"却都带指纹 ⇒ 必须报"可判 8 / 不可判 0"，并把会话内无从比对如实说出来', () => {
  assert.equal(WINDOW_SNAPSHOT.filter((r) => classify(r) === '真·首见').length, 8);
  assert.equal(WINDOW_SNAPSHOT.filter((r) => classify(r) === '换纪元').length, 0, '既有口径下"换纪元 0 次"是读数事实');
  const s = summarizeJudgeability(WINDOW_SNAPSHOT, 52);
  assert.equal(s.total, 8);
  assert.equal(s.judgeable, 8);
  assert.equal(s.unjudgeable, 0);
  assert.equal(s.byBasis.fingerprint, 8);
  assert.equal(s.noSessionAnchor, 8, '8 轮会话内都没有前序轮次 ⇒ "真·首见"不能读成"没换纪元"');
});
