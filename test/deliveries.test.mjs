// test/deliveries.test.mjs - 外部投递记录：幂等键语义 + 死信落点（D4/RA-42，2026-09-16）
//
// 这条防的是**真实故障**：调用方在收到 `done` 之前断线，无法判断活有没有派出去，于是重发 ——
// 从前重发会再落一条 user 消息、再跑一轮 agent（重复花钱 + 有副作用的工具执行两遍）。
// 夹具直接打真库（本仓既有做法，如 eventlog 归档用例），用哨兵 account_id 隔离并在结束时清理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, initSchema } from '../server/db.js';
import { beginDelivery, finishDelivery, listDeliveries, requestHash, IDEM_KEY_MAX, MAX_LIST } from '../server/deliveries.js';

// 哨兵账号：**每次运行唯一**（负数＝不是真实账号，与 eventlog-archive 的 -990004701 同款）。
// 为什么不能写死一个常量（原来是 999999）：本夹具"按账号清自己造的行"，而列表/计数读数也落在这个账号上 ——
// 写死就变成**两个并发进程共用一份可变数据**：谁先 clean()，谁就把对方刚插进去的行删掉；
// 谁后写，谁就把对方挤出列表窗口。**两个 npm test 同时在跑**（8 个代理并行时天天如此）当场互相打架。
// 2026-09-16 实测：并发两跑 4 轮全红，报错就是 `Cannot read properties of undefined (reading 'state')`。
// pid 保证同机不同进程不撞，随机后缀保证"多台机器连同一个库"时也不撞；salt 让同一进程里的两个哨兵账号
// 落在互不相交的区间（下面"跨账号边界"那条要造"别人的行"）。
const sentinel = (salt) => -(salt * 1_000_000 + (process.pid % 10_000) * 100 + Math.floor(Math.random() * 100));
const ACC = sentinel(1);     // 本夹具的主账号
const OTHER = sentinel(2);   // 第二个账号：只用来证明"别人的行读不到"
const K = (s) => 'test-' + s + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
const clean = async () => {
  try { await db.query('DELETE FROM deliveries WHERE account_id IN (?,?)', [ACC, OTHER]); } catch { /* ignore */ }
};

// 这条用例要打真表，而表由"服务启动时的 initSchema + 迁移链"建出来：夹具自己先确保一遍
// （initSchema 是幂等的与服务启动走同一条路径），否则在还没起过新版服务的机器上会以 ER_NO_SUCH_TABLE 报红，
// 那是在测"环境没准备好"，不是测这段逻辑。
test.before(async () => { await initSchema(); });

test('无幂等键也照记（每次调用一行），收尾后状态与结果可读', async () => {
  await clean();
  try {
    const a = await beginDelivery({ accountId: ACC, conversationId: 1 });
    assert.ok(a.id > 0 && a.fresh === true);
    await finishDelivery(a.id, { state: 'succeeded', messageId: 11, runId: 22, response: { messageId: 11, runId: 22, content: 'hi', usage: { total_tokens: 3 } } });
    // 按 id 读回**这条投递自己**的状态，而不是在 listDeliveries 的窗口里找自己：
    // 那个列表是**全表**倒序窗口（接口按 state 过滤，不按账号），并行跑时别人的新行会把我们这条挤出去 ——
    // 挤出去是"读数变了"，不是"收尾没写进去"，用它当判据就会报假红。列表 API 的映射由下面两条用例覆盖。
    const [row] = await db.query('SELECT state, message_id, run_id FROM deliveries WHERE id=?', [a.id]);
    assert.ok(row, '这条投递必须还在库里（不许被谁的清理顺手删掉）');
    assert.equal(row.state, 'succeeded');
    assert.equal(row.message_id, 11);
    assert.equal(row.run_id, 22);
  } finally { await clean(); }
});

test('有幂等键：进行中 → 409 语义；成功 → 回放原始接受结果；换参数 → 拒绝', async () => {
  await clean();
  const key = K('idem');
  const hash = requestHash({ conversationId: 7, content: '写个文件' });
  try {
    const first = await beginDelivery({ accountId: ACC, conversationId: 7, idemKey: key, hash });
    assert.equal(first.fresh, true, '第一次应当真的执行');
    const during = await beginDelivery({ accountId: ACC, conversationId: 7, idemKey: key, hash });
    assert.equal(during.conflict, 'in_progress', '上一次还在跑时必须拒绝重复（不排队、不阻塞）');
    await finishDelivery(first.id, { state: 'succeeded', messageId: 5, runId: 6, response: { messageId: 5, runId: 6, content: '做完了', usage: null } });
    const replay = await beginDelivery({ accountId: ACC, conversationId: 7, idemKey: key, hash });
    assert.deepEqual(replay.replay, { messageId: 5, runId: 6, content: '做完了', usage: null }, '重复请求要拿回**原始接受结果**，而不是再执行一遍');
    const reused = await beginDelivery({ accountId: ACC, conversationId: 7, idemKey: key, hash: requestHash({ conversationId: 7, content: '别的活' }) });
    assert.equal(reused.conflict, 'key_reused', '同一个键换了请求体必须拒（否则会拿旧结果糊弄）');
  } finally { await clean(); }
});

test('失败后可重发（这就是死信的人工重放路径），attempts 递增且只占一次', async () => {
  await clean();
  const key = K('retry');
  const hash = requestHash({ conversationId: 9, content: 'x' });
  try {
    const a = await beginDelivery({ accountId: ACC, conversationId: 9, idemKey: key, hash });
    await finishDelivery(a.id, { state: 'failed', error: '连接断开', errorCode: 'CLIENT_DISCONNECTED' });
    // 窗口取**接口自己的上限**（MAX_LIST＝《接口规范》§六 的列表上限）而不是随手写 50：
    // 死信列表同样是全表窗口，并发跑时别人的 failed 行会占掉窗口；窗口太窄会把我们这条挤出去 ——
    // 那是读数问题、不是"没落进死信"。这里仍然是在验**列表 API 的映射**（id/lastErrorCode 两个字段）。
    const failed = await listDeliveries({ state: 'failed', limit: MAX_LIST });
    assert.ok(failed.some((r) => r.id === String(a.id) && r.lastErrorCode === 'CLIENT_DISCONNECTED'), '失败要能在死信列表里看到');
    const again = await beginDelivery({ accountId: ACC, conversationId: 9, idemKey: key, hash });
    assert.equal(again.fresh, true, '失败的投递允许用同一个键重发');
    assert.equal(again.id, a.id, '重发是同一条记录（attempts 累加），不是新开一条');
    const rows = await db.query('SELECT attempts FROM deliveries WHERE id=?', [a.id]);
    assert.equal(Number(rows[0].attempts), 2, 'attempts 要如实累加（人看得出试过几次）');
    // 重发成功后再来一次 → 回放的是**新的**结果
    await finishDelivery(a.id, { state: 'succeeded', messageId: 77, runId: 88, response: { messageId: 77, runId: 88, content: '重发成功' } });
    const replay = await beginDelivery({ accountId: ACC, conversationId: 9, idemKey: key, hash });
    assert.equal(replay.replay.content, '重发成功');
  } finally { await clean(); }
});

test('并发同键：唯一索引保证只有一个真的进去，另一个被判"进行中"', async () => {
  await clean();
  const key = K('race');
  const hash = requestHash({ conversationId: 3, content: 'race' });
  try {
    const [x, y] = await Promise.all([
      beginDelivery({ accountId: ACC, conversationId: 3, idemKey: key, hash }),
      beginDelivery({ accountId: ACC, conversationId: 3, idemKey: key, hash }),
    ]);
    const fresh = [x, y].filter((r) => r.fresh).length;
    const conflict = [x, y].filter((r) => r.conflict === 'in_progress').length;
    assert.equal(fresh, 1, '同一刻只能有一个真的执行');
    assert.equal(conflict, 1, '另一个必须是"进行中"冲突（这是唯一索引兜住的，不靠应用层自觉）');
    const rows = await db.query('SELECT COUNT(*) c FROM deliveries WHERE account_id=?', [ACC]);
    assert.equal(Number(rows[0].c), 1, '只应留下一行');
  } finally { await clean(); }
});

test('跨账号边界：我的死信列表里不许出现别人的行，而我自己的行必须在（C-49）', async () => {
  await clean();
  try {
    const mine = await beginDelivery({ accountId: ACC, conversationId: 1, idemKey: K('mine'), hash: requestHash({ who: 'A' }) });
    await finishDelivery(mine.id, { state: 'failed', error: '我这轮没做完', errorCode: 'CLIENT_DISCONNECTED' });
    const theirs = await beginDelivery({ accountId: OTHER, conversationId: 2, idemKey: K('theirs'), hash: requestHash({ who: 'B' }) });
    await finishDelivery(theirs.id, { state: 'failed', error: '别人的活', errorCode: 'CLIENT_DISCONNECTED' });

    // 这条防的**真实缺口**：GET /api/deliveries 曾经只 requireAuth、而查询没有账号维度
    // ⇒ 任何登录账号都能读到别人的 idemKey/conversationId/lastError/messageId/runId。
    const scoped = (await listDeliveries({ state: 'failed', limit: MAX_LIST, accountId: ACC })).map((r) => r.id);
    assert.ok(scoped.includes(String(mine.id)), '我自己的死信必须在（不许用"返回空"糊过去）');
    assert.equal(scoped.includes(String(theirs.id)), false, '别人的死信不许出现在我的列表里');

    // 反过来也必须成立（判据是对称的，不是给某个账号开的特例）
    const other = (await listDeliveries({ state: 'failed', limit: MAX_LIST, accountId: OTHER })).map((r) => r.id);
    assert.ok(other.includes(String(theirs.id)));
    assert.equal(other.includes(String(mine.id)), false);

    // 不传 accountId ＝ 既有默认行为不变（无账号维度）：两条都还在这个视图里
    const all = (await listDeliveries({ state: 'failed', limit: MAX_LIST })).map((r) => r.id);
    assert.ok(all.includes(String(mine.id)) && all.includes(String(theirs.id)), '默认行为不许被这次收口改掉');
  } finally { await clean(); }
});

test('幂等键长度上限与列宽一致（超长键不会在库里被静默截断成别人的键）', () => {
  assert.equal(IDEM_KEY_MAX, 200, 'IDEM_KEY_MAX 必须与 deliveries.idem_key VARCHAR(200) 对齐');
});
