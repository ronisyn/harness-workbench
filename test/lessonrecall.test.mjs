// test/lessonrecall.test.mjs - OP-12 夹具：错题必须**按需**进召回面（宁缺勿滥）
// 依据《RW-Agent 架构 v1.1》§15 `OP-12`（reviews 能写能查但不进任何召回/注入面 ⇒ 经验复用未闭环）
// 与 §14.3 RA-09 的同一条纪律：用不上就**一个字节都不注入**。
// 本夹具的价值在负例 —— 无聊的注入比不注入更糟（每轮多烧 token 还干扰模型）。
import { test } from 'node:test';
import assert from 'node:assert';
import { lessonMode, lessonBlock, pickLessons, keywords, LESSON_INTENT_RE } from '../server/lessonrecall.js';

const L = (id, why, diff) => ({ id, bug_reason: why, difficulty: diff || '中' });

test('OP-12 负例：闲聊（无任务词）→ none，且不产出任何注入块', () => {
  const rows = [L(1, 'cohort.mjs 的探针判据写宽了，把真实会话误杀')];
  assert.equal(lessonMode('你好，今天天气怎么样', rows), 'none');
  assert.equal(lessonBlock(rows, 'none'), null, 'none 档必须返回 null（调用方据此跳过注入）');
});

test('OP-12 负例：库里没有错题 → none（即使消息是任务语境）', () => {
  assert.equal(lessonMode('帮我修复这个登录接口的报错', []), 'none');
  assert.equal(lessonMode('帮我修复这个登录接口的报错', null), 'none');
});

test('OP-12 负例：有错题但都不沾边 → none（不许"只要有错题就塞进去"）', () => {
  const rows = [L(1, 'Excel 解析时日期列被当成数字'), L(2, '飞书 webhook 验签需要原始 body')];
  assert.equal(lessonMode('帮我修复 nginx 反向代理 502', rows), 'none');
});

test('OP-12 正例：任务语境 + 实词重叠 → index，且只给**沾边的那几条**', () => {
  const rows = [L(7, 'cohort.mjs 探针判据写宽，把真实会话误杀；应限定"会话已删除"那一支', '大'), L(8, '飞书验签要原始 body')];
  const mode = lessonMode('继续修复 cohort.mjs 的探针判据问题', rows);
  assert.equal(mode, 'index');
  const picked = pickLessons('继续修复 cohort.mjs 的探针判据问题', rows);
  assert.deepEqual(picked.map((x) => x.id), [7], '只挑沾边的那条');
  const block = lessonBlock(picked, mode);
  assert.ok(block && block.includes('错题 #7'), '命中的那条必须出现');
  assert.ok(!block.includes('飞书验签'), '不沾边的那条不得混进来');
  assert.ok(block.length < 400, '只给结论，不许把整段复盘正文塞进来');
  assert.match(block, /db_query/, '要给出全量查法（正文留在库里）');
  assert.match(block, /自述不可信|实时查询为准/, '错题是当时结论，必须带上"以实时状态为准"的前提');
});

test('OP-12：条数上限生效（默认 3 条，可调）', () => {
  const rows = [1, 2, 3, 4, 5].map((i) => L(i, '部署脚本 回滚 演练 失败 记录 ' + i));
  assert.equal(pickLessons('部署脚本回滚演练失败', rows).length, 3, '默认最多挑 3 条');
  assert.equal(pickLessons('部署脚本回滚演练失败', rows, 5).length, 5);
  const b3 = lessonBlock(pickLessons('部署脚本回滚演练失败', rows), 'index');
  assert.equal((b3.match(/- \[错题 #/g) || []).length, 3, '默认最多 3 条');
  const b5 = lessonBlock(pickLessons('部署脚本回滚演练失败', rows, 5), 'index', { limit: 5 });
  assert.equal((b5.match(/- \[错题 #/g) || []).length, 5);
  assert.equal(lessonBlock(rows, 'none', { limit: 5 }), null, 'none 档无视 limit');
});

test('OP-12：关键词抽取可复现（中文 2-gram + 英文词；同输入同输出）', () => {
  const a = keywords('修复 cohort.mjs 的探针判据');
  const b = keywords('修复 cohort.mjs 的探针判据');
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.ok(a.has('cohort.mjs'), '英文/带点词要整词收进来');
  assert.ok(a.has('探针'), '中文要出 2-gram');
  assert.equal(keywords('').size, 0);
});

test('OP-12：任务语境正则覆盖"继续/接着做/自检"这类恢复语境（与假开始检测同源）', () => {
  for (const s of ['继续任务', '接着做吧', '自检一遍', '帮我看下为什么报错', '按计划执行']) {
    assert.ok(LESSON_INTENT_RE.test(s), '应判为任务语境: ' + s);
  }
  for (const s of ['你好', '谢谢', '今天几号']) assert.ok(!LESSON_INTENT_RE.test(s), '不应判为任务语境: ' + s);
});
