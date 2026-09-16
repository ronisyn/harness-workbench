// test/provider-register.test.mjs - 客户网关 / 内网推理的**注册入口**（v0.3 §4.3「可切云端/客户网关/内网推理」）
//
// 改造前的现状：providers **只能**来自代码清单 `server/llm/providers.js`（启动时同步进 `providers` 表）
//   ⇒ 客户要接自己的网关/内网推理**必须改代码**。本夹具锁住"不改代码也能接"的每一条判据：
//   ① **装配期校验 + 明确报错**：缺字段 / 非法 base / 未知字段（＝有人想塞明文密钥）一律拒，且逐条说清；
//   ② **落库形状**：`providers` 行（provider_key/name/base_url/api_key_env）+ `models` 行（默认模型 + chatModels），
//      复用既有 `syncChatModels`（不另造目录同步路径）；
//   ③ **凭证只有一条路**：条目只写 `keyEnv`，槽位按既有约定 `<KEYENV 大写>_API_KEY` 绑到 `keys` 上，
//      读取点全是 `keys[keyEnv]`（＝gateway 的 resolve）——**不收明文、不进 DB、不进响应**；
//   ④ **与启动的"清单同步"不打架**：内置厂商的行**不**被当成注册厂商载入；注册厂商的行在启动时载入内存注册表
//      （否则路由找不到它）；脏行**报错并跳过**（不阻断启动、也不静默）；默认模型从既有 `models` 行补回；
//   ⑤ **注销的边界**：内置 id 当场拒且**一条 SQL 都不发**（不许先删再判）；只对自注册的生效。
//
// 环境：**假库 + 假 keys**（不碰真库：真库会被读/被写；不调模型、不连外部服务、不新增任何环境依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  PROVIDERS, activeProviders, allProviders, findProvider, isManifestProvider,
  validateProvider, normalizeProvider, keySlotEnvName, bindKeySlot,
  registerProvider, unregisterProvider, providerRemovalProblem,
  saveRegisteredProvider, removeRegisteredProvider, loadRegisteredProviders,
} = await import('../server/llm/providers.js');
const { syncChatModels } = await import('../server/llm/providers.js');

const GOOD = () => ({ id: 'acme_gw', name: '客户网关', base: 'http://10.0.0.5:8000/v1', keyEnv: 'acme_gw' });
const ENV_VAR = 'ACME_GW_API_KEY';

/** 假库：只认本批真正会发出的那 7 条语句（其余一律抛错，免得夹具悄悄假装支持了什么）。
 *  造的是**内存里的 providers/models 两张表** + 一份 SQL 流水（用来证明"拒绝的路径一条语句都没发"）。 */
class FakeDb {
  constructor() { this.providers = []; this.models = []; this.log = []; this.seq = 0; }
  rowsOfProviders() { return this.providers.map((p) => ({ id: p.id, provider_key: p.provider_key, name: p.name, base_url: p.base_url, api_key_env: p.api_key_env })); }
  rowsOfModels() { return this.models.map((m) => ({ provider_id: m.provider_id, model_id: m.model_id, name: m.name })); }
  async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    this.log.push(s);
    if (/^SELECT id FROM providers WHERE provider_key=\?$/.test(s)) {
      const r = this.providers.find((p) => p.provider_key === params[0]);
      return r ? [{ id: r.id }] : [];
    }
    if (/^INSERT INTO providers \(provider_key, name, base_url, api_key_env, enabled, sort_order\) VALUES \(\?,\?,\?,\?,1,\?\)$/.test(s)) {
      const row = { id: ++this.seq, provider_key: params[0], name: params[1], base_url: params[2], api_key_env: params[3], enabled: 1, sort_order: params[4] };
      this.providers.push(row);
      return { insertId: row.id, affectedRows: 1 };
    }
    if (/^UPDATE providers SET name=\?, base_url=\?, api_key_env=\? WHERE id=\?$/.test(s)) {
      const row = this.providers.find((p) => p.id === params[3]);
      if (row) { row.name = params[0]; row.base_url = params[1]; row.api_key_env = params[2]; }
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^DELETE FROM providers WHERE id=\?$/.test(s)) {
      const n = this.providers.length;
      this.providers = this.providers.filter((p) => p.id !== params[0]);
      return { affectedRows: n - this.providers.length };
    }
    if (/^DELETE FROM models WHERE provider_id=\?$/.test(s)) {
      const n = this.models.length;
      this.models = this.models.filter((m) => m.provider_id !== params[0]);
      return { affectedRows: n - this.models.length };
    }
    if (/^UPDATE models SET name=\? WHERE provider_id=\? AND name=\?$/.test(s)) {
      const row = this.models.find((m) => m.provider_id === params[1] && m.name === params[2]);
      if (row) row.name = params[0];
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^INSERT INTO models \(provider_id, model_id, name, capabilities, enabled, added_at, last_seen_at\) VALUES \(\?,\?,\?,\?,1,NOW\(\),NOW\(\)\) ON DUPLICATE KEY UPDATE (?:enabled=1|last_seen_at=NOW\(\))$/.test(s)) {
      const [pid, mid, name, caps] = params;
      if (this.models.some((m) => m.provider_id === pid && m.model_id === mid)) return { insertId: 0, affectedRows: 0 };
      this.models.push({ provider_id: pid, model_id: mid, name, capabilities: caps });
      return { insertId: this.models.length, affectedRows: 1 };
    }
    throw new Error('假库不认识的查询：' + s);
  }
}

/** 每个用例自己收摊：注册进内存注册表的条目必须摘掉（同一进程里的后一条用例不该看到前一条的残留）。 */
const REGISTERED_IDS = new Set();
test.beforeEach(() => {
  for (const id of REGISTERED_IDS) unregisterProvider(id);
  REGISTERED_IDS.clear();
});
test.after(() => {
  for (const id of REGISTERED_IDS) unregisterProvider(id);
  delete process.env[ENV_VAR];
});

// ── ① 装配期校验：缺字段 / 非法 base / 未知字段（明文密钥）一律拒 ────────────────────────
test('校验：合法条目零问题（正对照）；缺字段/非法 base/未知字段逐条报出', () => {
  assert.deepEqual(validateProvider(GOOD()), [], '正对照：这条声明必须零问题（没有它，下面的负例可能是"永远报错"的假通过）');
  const bad = (patch, re, why) => {
    const problems = validateProvider({ ...GOOD(), ...patch });
    assert.ok(problems.length, '必须报错：' + why);
    assert.match(problems.join('\n'), re, why + ' → 实际：' + problems.join('；'));
  };
  assert.match(validateProvider(null)[0], /必须是对象/, '条目不是对象');
  assert.match(validateProvider([GOOD()])[0], /必须是对象/, '条目是数组');
  bad({ id: 'Acme' }, /id 非法/, 'id 含大写（它会进 URL 与日志）');
  bad({ id: 'a' }, /id 非法/, 'id 太短（1 位）');
  bad({ id: 'deepseek' }, /id 与内置厂商冲突/, '占用内置厂商 id（代码清单是内置厂商的唯一权威）');
  bad({ name: '' }, /缺 name/, '缺显示名');
  bad({ name: 'x'.repeat(65) }, /name 过长/, 'name 超列宽 VARCHAR(64)');
  bad({ base: 'http://10.0.0.5:8000/v1?x=1' }, /base 非法/, 'base 带查询串（它要拼 /chat/completions）');
  bad({ base: '10.0.0.5:8000' }, /base 非法/, 'base 不是绝对 URL');
  bad({ base: 'ftp://10.0.0.5' }, /base 非法/, 'base 协议不是 http(s)');
  bad({ base: undefined }, /base 非法/, '缺 base');
  bad({ keyEnv: 'ACME' }, /keyEnv 非法/, 'keyEnv 不是小写标识符');
  bad({ keyEnv: undefined }, /keyEnv 非法/, '缺 keyEnv（凭证引用是必填的）');
  bad({ timeoutMs: 0 }, /timeoutMs 必须是正有限数/, 'timeoutMs 非法');
  bad({ capabilities: ['chat', 1] }, /capabilities 必须是/, 'capabilities 里混了非字符串');
  bad({ chatModels: 'acme-1' }, /chatModels 必须是字符串数组/, 'chatModels 不是数组');
  bad({ capabilitiesDeclared: { video: true } }, /不是既有三维/, 'capabilitiesDeclared 自造维度');
  bad({ capabilitiesDeclared: { vision: 'no' } }, /必须是布尔/, 'capabilitiesDeclared 值不是布尔');
  // **凭证路径的唯一性**（§9：不收明文）：请求体里塞密钥＝未知字段 ⇒ 当场拒（拼错的字段静默忽略最坑人）
  bad({ apiKey: 'sk-plaintext' }, /未知字段 apiKey/, '明文密钥字段（不存在这条凭证路径）');
  bad({ baseUrl: 'http://10.0.0.5:8000/v1' }, /未知字段 baseUrl/, '字段名拼成 baseUrl（清单里叫 base）');
  // 一次报多条（收集式，不是"撞到第一条就停"）
  const multi = validateProvider({ id: 'BAD', name: '', base: 'nope', keyEnv: 'X' }).join('\n');
  for (const re of [/id 非法/, /缺 name/, /base 非法/, /keyEnv 非法/]) assert.match(multi, re, '同一次校验要把问题报全：' + re);
});

// ── ② 注册：落库 + 内存注册表 + 槽位绑定 + 路由判据 ─────────────────────────────────────
test('注册：落库形状 + 注册进内存注册表 + keyEnv 槽位按既有约定绑定 + 已接入可见', async () => {
  const db = new FakeDb();
  const keys = { deepseek: 'ds-key' };            // 假 keys：内置槽位用真 config.keys 的形状（只读它们，不改）
  process.env[ENV_VAR] = 'sk-acme';
  const def = { ...GOOD(), base: 'http://10.0.0.5:8000/v1/', defaultModel: 'acme-1', capabilities: ['chat', 'tool'], chatModels: ['acme-1', 'acme-2'], capabilitiesDeclared: { vision: false } };

  const r = await saveRegisteredProvider(db, def, keys, { mustNotExist: true });
  REGISTERED_IDS.add('acme_gw');
  assert.equal(r.ok, true, '注册必须成功：' + (r.error || ''));
  assert.equal(r.created, true);
  assert.equal(r.entry.base, 'http://10.0.0.5:8000/v1', 'base 尾斜杠去掉（既有拼接口径是 base + "/chat/completions"）');

  // ① 落库形状（providers 一行 + models 两行）
  assert.deepEqual(db.rowsOfProviders().map((p) => [p.provider_key, p.name, p.base_url, p.api_key_env]),
    [['acme_gw', '客户网关', 'http://10.0.0.5:8000/v1', 'acme_gw']], 'providers 行必须是清单同形字段：' + JSON.stringify(db.rowsOfProviders()));
  assert.deepEqual(db.models.map((m) => m.model_id), ['acme-1', 'acme-2'], '默认模型 + chatModels 必须入库（复用 syncChatModels）');
  assert.equal(db.models[0].name, '客户网关 默认模型', '默认模型的行名口径与内置厂商播种时逐字一致（启动靠它补回 defaultModel）');

  // ② 内存注册表＝路由的唯一判据（gateway 的 resolve → findProvider）
  assert.equal(findProvider('acme_gw').name, '客户网关');
  assert.equal(isManifestProvider('acme_gw'), false, '它不属于代码清单（可删）');
  assert.equal(isManifestProvider('deepseek'), true, '内置厂商仍在清单里（id 被保留）');

  // ③ 凭证只有一条路：keys[keyEnv]（＝ config.keys[keyEnv]）
  assert.equal(keySlotEnvName('acme_gw'), ENV_VAR);
  assert.equal(keys.acme_gw, 'sk-acme', '槽位必须绑到 keys 上（gateway 的 resolve 读的就是这一格）');
  assert.equal(keys.deepseek, 'ds-key', '内置槽位一个字都不动（绑定由 server/config.js 显式给出）');
  assert.ok(activeProviders(keys).some((p) => p.id === 'acme_gw'), '已配 Key ⇒ 必须进"已接入厂商"（/api/models 读它）');
  assert.equal(allProviders(keys).find((p) => p.id === 'acme_gw').connected, true);
  // 响应体里不许出现密钥真值：注册返回值只回声明与提示
  assert.equal(JSON.stringify(r).includes('sk-acme'), false, '注册响应里不得出现密钥真值');

  // ④ 明文密钥进不来：整条路径拒掉，且**一条 SQL 都没发、内存也没动**
  const dbLog = db.log.length;
  const bad = await saveRegisteredProvider(db, { ...GOOD(), id: 'acme2', apiKey: 'sk-plaintext' }, keys, { mustNotExist: true });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join('\n'), /未知字段 apiKey/);
  assert.equal(db.log.length, dbLog, '被拒的注册不得发出任何 SQL（先校验后动手）');
  assert.equal(findProvider('acme2'), undefined);
  assert.equal(db.providers.length, 1);
});

// ── ③ 更新与两种"存在性"约束 ─────────────────────────────────────────────────────────
test('更新：POST 不许覆盖已有（mustNotExist）、PUT 不许悄悄新建（mustExist），更新落库并立即换掉路由里的那一条', async () => {
  const db = new FakeDb();
  const keys = {};
  const r1 = await saveRegisteredProvider(db, GOOD(), keys, { mustNotExist: true });
  REGISTERED_IDS.add('acme_gw');
  assert.equal(r1.ok, true, r1.error);
  const dup = await saveRegisteredProvider(db, GOOD(), keys, { mustNotExist: true });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /已注册/, 'POST 撞已有 id 必须报错（改它用 PUT），不许静默覆盖：' + dup.error);
  const ghost = await saveRegisteredProvider(db, { ...GOOD(), id: 'ghost_gw' }, keys, { mustExist: true });
  assert.equal(ghost.ok, false);
  assert.match(ghost.error, /未注册/, 'PUT 未注册的 id 必须报错（不许悄悄新建）：' + ghost.error);

  const r2 = await saveRegisteredProvider(db, { ...GOOD(), base: 'http://10.0.0.9:9000/v1', defaultModel: 'acme-9' }, keys, { mustExist: true });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.created, false, '这一条是更新，不是新建');
  assert.equal(db.providers.length, 1, '更新不得多出一行');
  assert.equal(db.providers[0].base_url, 'http://10.0.0.9:9000/v1', 'UPDATE 必须落到 base_url');
  assert.equal(findProvider('acme_gw').base, 'http://10.0.0.9:9000/v1', '内存注册表必须立即换掉（热生效，不重启）');
  assert.equal(PROVIDERS.filter((p) => p.id === 'acme_gw').length, 1, '替换而不是追加（同名只许一条）');

  // 改名：默认模型那一行的行名必须跟着改（它是启动载入时补回 defaultModel 的唯一线索——
  // 不改的话"改一次名，重启后默认模型就丢了"，而那正是本批要治的"注册了却不生效"）
  const r3 = await saveRegisteredProvider(db, { ...GOOD(), name: '客户网关二号', base: 'http://10.0.0.9:9000/v1', defaultModel: 'acme-9' }, keys, { mustExist: true });
  assert.equal(r3.ok, true, r3.error);
  assert.equal(db.models.find((m) => m.model_id === 'acme-9').name, '客户网关二号 默认模型', '改名后线索行必须同步（否则重启即丢默认模型）');
  // 载入路径上验证同一件事：改名后的行仍能把 defaultModel 补回来
  const reload = loadRegisteredProviders(db.rowsOfProviders().filter((p) => p.provider_key === 'acme_gw'), keys, db.rowsOfModels());
  assert.deepEqual(reload.loaded, ['acme_gw']);
  assert.equal(findProvider('acme_gw').defaultModel, 'acme-9', '重启载入必须补回默认模型');
});

// ── ④ 注销的边界：内置 id 当场拒且一条 SQL 都不发 ────────────────────────────────────────
test('注销：只对自注册的生效；内置 id 当场拒且**一条 SQL 都不发**（不许先删再判）', async () => {
  const db = new FakeDb();
  const keys = {};
  const reg = await saveRegisteredProvider(db, { ...GOOD(), defaultModel: 'acme-1', chatModels: ['acme-1', 'acme-2'] }, keys, { mustNotExist: true });
  REGISTERED_IDS.add('acme_gw');
  assert.equal(reg.ok, true, reg.error);
  assert.equal(db.models.length, 2);

  // 内置 id：拒绝理由先给（只读判据），再断言"什么都没发生"
  assert.match(providerRemovalProblem('deepseek'), /内置厂商/);
  const logBefore = db.log.length;
  const r1 = await removeRegisteredProvider(db, 'deepseek');
  assert.equal(r1.ok, false);
  assert.match(r1.error, /内置厂商的 id 由代码清单占用/);
  assert.equal(db.log.length, logBefore, '拒绝的注销不得发出任何 SQL');
  assert.ok(findProvider('deepseek'), '内置厂商必须仍在注册表里');
  assert.equal(PROVIDERS.some((p) => p.id === 'deepseek'), true);

  // 未注册 id：同样拒
  assert.match((await removeRegisteredProvider(db, 'no_such_gw')).error, /未注册的厂商/);

  // 自注册：库行 + 目录行 + 内存条目一起走
  const r2 = await removeRegisteredProvider(db, 'acme_gw');
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.models, 2, '该厂商的模型目录行必须一并清掉（否则菜单里留孤儿）');
  assert.deepEqual(db.rowsOfProviders(), []);
  assert.deepEqual(db.models, []);
  assert.equal(findProvider('acme_gw'), undefined, '内存注册表必须摘掉（否则这一进程还能路由到一个已删除的厂商）');
  REGISTERED_IDS.delete('acme_gw');
});

// ── ⑤ 与启动的"清单同步"的交互（谁权威、谁不动谁、脏行怎么办）──────────────────────────
test('启动载入：内置厂商的行不被当成注册厂商；注册行载入并补回默认模型；脏行报错跳过（不阻断、不静默）', () => {
  const keys = {};
  process.env[ENV_VAR] = 'sk-acme';
  const before = PROVIDERS.length;
  const builtinRow = (p) => ({ id: p.id, provider_key: p.id, name: p.name, base_url: p.base, api_key_env: p.keyEnv });
  const rows = [
    // 内置 10 行（启动时 SELECT 出来的形状）——**只取代码清单里的**：注册表此刻还带着前几条用例注册的厂商
    ...allProviders({}).filter((p) => isManifestProvider(p.id)).map(builtinRow),
    { id: 101, provider_key: 'rowgw', name: '内网推理', base_url: 'http://10.0.0.7:11434/v1', api_key_env: 'rowgw' },
    { id: 102, provider_key: 'broken_row', name: '坏行', base_url: 'not-a-url', api_key_env: 'broken_row' },
  ];
  const modelsRows = [
    { provider_id: 101, model_id: 'row-model-1', name: '内网推理 默认模型' },   // 注册时写下的默认模型行（口径一致）
    { provider_id: 101, model_id: 'row-model-2', name: 'row-model-2' },
  ];
  const r = loadRegisteredProviders(rows, keys, modelsRows);
  REGISTERED_IDS.add('rowgw');
  assert.deepEqual(r.loaded, ['rowgw'], '只有不在清单里的那一行被载入：' + JSON.stringify(r));
  assert.deepEqual(r.skipped, ['broken_row']);
  assert.match(r.problems.join('\n'), /broken_row：base 非法/, '脏行必须如实报出（不静默跳过）：' + r.problems.join('；'));
  assert.equal(PROVIDERS.length, before + 1, '内置 10 行不得被当成注册厂商追加进注册表');
  assert.equal(findProvider('rowgw').defaultModel, 'row-model-1', '默认模型必须从既有 models 行补回（否则重启后 explicit 路由会拿到空模型名）');
  assert.equal(findProvider('rowgw').chatModels.length, 0, '目录由 models 表承载，不在 providers 行里（如实）');
  // 幂等：再载入一次不会多出一条
  const r2 = loadRegisteredProviders(rows, keys, modelsRows);
  assert.deepEqual(r2.loaded, ['rowgw']);
  assert.equal(PROVIDERS.filter((p) => p.id === 'rowgw').length, 1, '重复载入必须替换而不是追加');
  // 缺 models 行时如实留空（不猜"第一个模型就是默认"）
  unregisterProvider('rowgw');
  const r3 = loadRegisteredProviders([{ id: 103, provider_key: 'nogw', name: '无目录网关', base_url: 'http://10.0.0.8:8000/v1', api_key_env: 'nogw' }], keys, []);
  REGISTERED_IDS.add('nogw');
  assert.deepEqual(r3.loaded, ['nogw']);
  assert.equal(findProvider('nogw').defaultModel, '', '查不到默认模型就留空串（不猜）');
});

// ── ⑥ 纯函数边界 + 端点接线（源码级）：凭证/权威口径不许被后来者改回去 ────────────────────
test('纯函数边界：normalizeProvider 默认值、bindKeySlot 不覆盖已有槽位', () => {
  const e = normalizeProvider(GOOD());
  assert.deepEqual(e.capabilities, ['chat'], '未声明 capabilities ⇒ ["chat"]');
  assert.deepEqual(e.chatModels, []);
  assert.equal(e.defaultModel, '');
  assert.equal(e.timeoutMs, undefined, '未声明就不写这一格（与清单同形：不发明默认超时）');
  const keys = { deepseek: 'ds' };
  assert.equal(bindKeySlot(keys, 'deepseek'), null, '已存在的槽位不重建（内置绑定归 server/config.js）');
  assert.equal(keys.deepseek, 'ds');
  assert.equal(bindKeySlot(keys, 'fresh_gw'), 'FRESH_GW_API_KEY');
  process.env.FRESH_GW_API_KEY = 'k2';
  assert.equal(keys.fresh_gw, 'k2', '懒解析：每次现取（环境变量轮换下一轮生效）');
  delete process.env.FRESH_GW_API_KEY;
  assert.equal(keys.fresh_gw, '', '没配就是空串（falsy ⇒ "未配置 Key"，与内置槽位同一语义）');
});

test('端点接线（源码级）：三个写口都在、都沿用 requireAuth，启动块真的调了载入，且 GET 只增 source', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(idx, /app\.post\('\/api\/providers', requireAuth, async \(req, res\) => \{/, '注册口必须在，且沿用既有鉴权');
  assert.match(idx, /app\.put\('\/api\/providers\/:id', requireAuth, async \(req, res\) => \{/, '更新口必须在');
  assert.match(idx, /app\.delete\('\/api\/providers\/:id', requireAuth, async \(req, res\) => \{/, '注销口必须在');
  assert.match(idx, /loadRegisteredProviders\(rows, config\.keys, await db\.query\('SELECT provider_id, model_id, name FROM models'\)\)/,
    '启动块必须真的把库里的自注册厂商载入内存注册表（否则"注册了却不生效"）');
  assert.match(idx, /source: isManifestProvider\(p\.provider_key\) \? 'manifest' : 'registered'/, 'GET /api/providers 只增 source 字段');
  assert.match(idx, /PUT 是整体替换（清单同形字段需一并给出，只改一处也请带上 id\/name\/base\/keyEnv）/, 'PUT 是整体替换：只传一半必须当场说清（真服务读数里撞到过"只传 base"被拒却看不出原因）');
  assert.match(idx, /for \(const p of allProviders\(config\.keys\)\) \{\n\s+if \(have\.has\(p\.id\)\) continue;/, '内置厂商按 id 逐家补缺行（不再"表空了才播种"——那会与自注册打架）');
});
