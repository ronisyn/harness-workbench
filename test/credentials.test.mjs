// test/credentials.test.mjs - 凭据单一访问路径（C-18，2026-09-15）
//
// 背景：`settings.mcp_servers[].env` 原样明文存着 GitHub PAT。出站有脱敏（redactMcpServers / redactSecrets），
// 但 `db_query` 是通用 SELECT ⇒ 模型能绕开所有脱敏出口把明文读走。修法＝把明文搬出业务表 + 单一访问路径
// （照 DSH `dsh-credentials` / `dsh-credentials-local`：引用进配置、值进专用文档、每次操作现取、空值等于没配）。
//
// 本夹具锁住四件事（任务点名的四条）：
//   ① 读不到明文：返回值与**日志**里都不出现原文；
//   ② 只列名不列值；
//   ③ 未配置时的行为（不抛错、如实报告"没配"，而不是塞空串）；
//   ④ 迁移幂等（跑两遍结果一致）、失败不破坏现有配置。
// 另外两条是这次改动**很容易悄悄弄坏**的东西，所以一并锁：老配置的兼容读取、配置里普通值的原样透传。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 夹具放在 scripts/fixtures：`node --test` 会把 test/**/*.mjs 全当测试文件，而它是"等 stdin 说话"的常驻进程
const ENV_ECHO = path.join(HERE, '../scripts/fixtures/env-echo-mcp-server.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-cred-'));
const FILE = path.join(TMP, '.credentials.yaml');
// 必须在 import 之前设：credentials.js 每次调用都现算路径（不缓存），所以改它即可切换存储
process.env.RW_CREDENTIALS_FILE = FILE;

const { getSecret, setSecret, listSecretNames, describeSecret, redactSummary, resolveEnv, resolveEnvValue,
  migrateMcpSecrets, readMcpConfig, credentialsFile, redactSecretValues, unsetSecret, CRED_PREFIX } =
  await import('../server/credentials.js');
const { connectMcp, disconnectMcp, callMcpTool, connectConfiguredMcps } = await import('../server/mcp.js');
const { db } = await import('../server/db.js');

// 形状与真凭据一致（`ghp_` + 36 位 = 40），但不含任何真实密钥
const TOKEN = 'ghp_' + 'A'.repeat(36);
const TOKEN2 = 'ghp_' + 'B'.repeat(36);
/** 用一定不会出现在真实环境里的名字，避免与环境变量撞车。 */
const NAME = 'FAKE_C18_TOKEN';
assert.ok(!process.env[NAME], '夹具前提：' + NAME + ' 不得已存在于进程环境里');

const reset = () => { for (const f of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, f), { force: true, recursive: true }); };
test.beforeEach(reset);
/** 2026-09-16 改：`connectConfiguredMcps` 现在**接受可注入的库**（普通参数，缺省真库），
 *  不再需要 `__setDbForTest()` 那种"就地改模块级绑定"的测试缝——夹具直接把假库传进去即可。 */

/** 夹具假库：只认 settings 那一张表的两条语句，其余一律抛错（免得夹具悄悄假装支持了什么）。 */
class FakeDb {
  constructor(cfg) { this.rows = new Map([['mcp_servers', JSON.stringify(cfg)]]); this.calls = []; }
  cfg() { return JSON.parse(this.rows.get('mcp_servers')); }
  async query(sql, params) {
    this.calls.push(sql);
    if (/^SELECT svalue FROM settings WHERE skey=\?$/.test(sql)) {
      return this.rows.has(params[0]) ? [{ svalue: this.rows.get(params[0]) }] : [];
    }
    throw new Error('假库不认识的查询：' + sql);
  }
  async run(sql, params) {
    this.calls.push(sql);
    if (/^UPDATE settings SET svalue=\?, updated_at=NOW\(\) WHERE skey=\?$/.test(sql)) {
      this.rows.set(params[1], params[0]);
      return { affectedRows: 1 };
    }
    throw new Error('假库不认识的写入：' + sql);
  }
}

// ── ①②③ 文档存储本身 ────────────────────────────────────────────────────────────────
test('未配置时必须如实报告"没配"，而不是抛错或塞空串', () => {
  assert.equal(fs.existsSync(FILE), false, '前置：文档不存在');
  assert.equal(getSecret(NAME), undefined, '没配就是 undefined（不是空串——空串会被当成已配置的密钥）');
  assert.deepEqual(listSecretNames(), []);
  assert.deepEqual(describeSecret(NAME), { name: NAME, configured: false, source: null, writable: true });
  assert.deepEqual(redactSummary([]), { store: FILE, configured: [], missing: [] });
});

test('存储位置由 RW_CREDENTIALS_FILE 决定（部署可换到别处）', () => {
  assert.equal(credentialsFile(), FILE);
});

test('写入后能取回；只列名不列值；describe 只回答"配没配"', () => {
  setSecret(NAME, TOKEN);
  assert.equal(getSecret(NAME), TOKEN);
  assert.deepEqual(listSecretNames(), [NAME], '只列名');
  assert.equal(JSON.stringify(listSecretNames()).includes(TOKEN), false, '名字列表里不得出现值');
  const info = describeSecret(NAME);
  assert.deepEqual(info, { name: NAME, configured: true, source: 'file', writable: true });
  assert.equal(JSON.stringify(info).includes(TOKEN), false, 'describe 的输出里不得出现值');
});

test('redactSummary 可安全打印：含名字，不含值', () => {
  setSecret(NAME, TOKEN);
  const cfg = [{ id: 'github', command: 'npx', args: [], env: { GITHUB_PERSONAL_ACCESS_TOKEN: CRED_PREFIX + NAME } }];
  const sum = redactSummary(cfg);
  const text = JSON.stringify(sum);
  assert.equal(text.includes(TOKEN), false, '摘要里绝不能出现明文');
  assert.deepEqual(sum.configured, [{ name: NAME, source: 'file', writable: true }]);
  assert.deepEqual(sum.missing, []);
  // 引用了但没配 ⇒ 出现在 missing 里（自检据此报警），而不是静默消失
  const sum2 = redactSummary([{ id: 'x', env: { K: CRED_PREFIX + 'NOT_CONFIGURED_C18' } }]);
  assert.deepEqual(sum2.missing, ['NOT_CONFIGURED_C18']);
  assert.ok(!JSON.stringify(sum2).includes(TOKEN));
});

test('redactSecretValues：日志出口的兜底替换（外部程序把密钥回显出来时）', () => {
  setSecret(NAME, TOKEN);
  const out = redactSecretValues('server said ' + NAME + '=' + TOKEN + ' oops');
  assert.equal(out.includes(TOKEN), false);
  assert.equal(out, 'server said ' + NAME + '=[REDACTED:' + NAME + '] oops');
});

test('空值拒绝、名字非法拒绝、启动环境已提供的名字拒绝写入（与 DSH 同口径）', () => {
  assert.throws(() => setSecret(NAME, ''), /不得为空/);
  assert.throws(() => setSecret('有中文名', TOKEN), /凭据名非法/);
  process.env[NAME] = 'from-launch-env';
  try {
    assert.throws(() => setSecret(NAME, TOKEN), /由启动环境提供/);
    assert.equal(getSecret(NAME), 'from-launch-env', 'env 分层赢过文件（DSH：启动环境只读且优先）');
    assert.equal(describeSecret(NAME).writable, false, '被 env 遮蔽时必须报只读，不能假装可写');
  } finally { delete process.env[NAME]; }
});

test('明文写出后文件本人可读（POSIX 0600；Windows 无 POSIX 模式，跳过这项检查）', { skip: process.platform === 'win32' }, () => {
  setSecret(NAME, TOKEN);
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  fs.chmodSync(FILE, 0o644);
  assert.throws(() => getSecret(NAME), /属主之外可读/, '别人可读的文件必须拒绝读（否则 0600 的承诺是空的）');
});

test('文档格式错必须报错，不静默跳过那一行（"我存了却没生效"必须查得出来）', () => {
  fs.writeFileSync(FILE, 'GOOD_TOKEN: abc\n这一行没有冒号\n', { mode: 0o600 });
  assert.throws(() => getSecret(NAME), /第 2 行格式非法/);
});

test('unsetSecret 撤销一项，其余不动', () => {
  setSecret(NAME, TOKEN); setSecret(NAME + '_2', TOKEN2);
  assert.deepEqual(unsetSecret(NAME), { name: NAME, removed: true });
  assert.deepEqual(listSecretNames(), [NAME + '_2']);
  assert.deepEqual(unsetSecret(NAME), { name: NAME, removed: false }, '本来就没有＝无事发生');
});

// ── 与 MCP 配置的接缝 ──────────────────────────────────────────────────────────────
test('引用解析：显式引用取真值；缺凭据如实报错（不塞空串、不静默降级）', () => {
  setSecret(NAME, TOKEN);
  assert.equal(resolveEnvValue('X', CRED_PREFIX + NAME), TOKEN);
  assert.throws(() => resolveEnvValue('X', CRED_PREFIX + 'NOT_CONFIGURED_C18'), /缺少凭据 NOT_CONFIGURED_C18/);
  // 普通配置值原样透传（不因为"长得像标识符"就被当成引用）
  assert.equal(resolveEnvValue('GITHUB_API_URL', 'https://api.github.com'), 'https://api.github.com');
  assert.equal(resolveEnvValue('MODE', 'strict'), 'strict');
});

test('生效值可以是明文，兼容读取也必须被**凭据里的同名项**顶掉', () => {
  const legacy = [{ id: 'github', command: 'npx', args: [], env: { [NAME]: 'legacy-plaintext-value' } }];
  assert.equal(resolveEnv(legacy[0].env)[NAME], 'legacy-plaintext-value', '没配凭据时：明文照旧生效（不静默降级成空）');
  setSecret(NAME, TOKEN);
  assert.equal(resolveEnv(legacy[0].env)[NAME], TOKEN, '配了同名凭据后：它才是生效来源，明文不再是');
});

// ── ④ 迁移 ────────────────────────────────────────────────────────────────────────
test('迁移：明文搬进文档、settings 里只剩引用、普通配置值一字不动', async () => {
  const fake = new FakeDb([{ id: 'github', command: 'npx', args: ['-y', 'x'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN, GITHUB_API_URL: 'https://api.github.com' } }]);
  const r = await migrateMcpSecrets(fake);
  assert.deepEqual(r.migrated, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.deepEqual(r.failed, []);
  assert.equal(r.applied, true);
  assert.equal(getSecret('GITHUB_PERSONAL_ACCESS_TOKEN'), TOKEN, '值搬进了文档');
  const after = fake.cfg();
  assert.equal(after[0].env.GITHUB_PERSONAL_ACCESS_TOKEN, CRED_PREFIX + 'GITHUB_PERSONAL_ACCESS_TOKEN');
  assert.equal(after[0].env.GITHUB_API_URL, 'https://api.github.com', '普通配置值不得被搬走或改写');
  assert.equal(JSON.stringify(fake.rows.get('mcp_servers')).includes(TOKEN), false, 'settings 里不得再留明文');
  assert.equal(JSON.stringify(after).includes(TOKEN), false);
  assert.equal(resolveEnv(after[0].env).GITHUB_PERSONAL_ACCESS_TOKEN, TOKEN, '迁移后解析结果与迁移前一致');
  assert.deepEqual(after[0].args, ['-y', 'x'], '其余字段逐字不动');
});

test('迁移幂等：连跑两遍，第二遍零改动、不覆盖已有凭据', async () => {
  const fake = new FakeDb([{ id: 'github', command: 'npx', env: { GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN } }]);
  const r1 = await migrateMcpSecrets(fake);
  const snapshot = fake.rows.get('mcp_servers');
  const r2 = await migrateMcpSecrets(fake);
  assert.equal(r1.migrated.length, 1);
  assert.deepEqual(r2.migrated, [], '第二遍没有可搬的');
  assert.deepEqual(r2.skipped, ['GITHUB_PERSONAL_ACCESS_TOKEN'], '已是引用 ⇒ 记为跳过，而不是又搬一次');
  assert.equal(r2.applied, true, '仍要落库（把引用写回），语义是"幂等"不是"第二次就什么都不做"');
  assert.equal(fake.rows.get('mcp_servers'), snapshot, '第二遍的结果与第一遍逐字相同');
  // 文档里已有值：运营换过钥匙时迁移不得把它盖回旧值
  setSecret('GITHUB_PERSONAL_ACCESS_TOKEN', TOKEN2);
  await migrateMcpSecrets(new FakeDb([{ id: 'github', command: 'npx', env: { GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN } }]));
  assert.equal(getSecret('GITHUB_PERSONAL_ACCESS_TOKEN'), TOKEN2, '已有凭据不得被老配置里的明文覆盖');
});

test('迁移不破坏现有配置：写文档失败时，settings 一个字都不改（明文原样保留、照旧生效）', async () => {
  // 让文档路径不可写（父路径是个文件）⇒ setSecret 抛错
  const parent = path.join(TMP, 'blocked');
  fs.writeFileSync(parent, 'not a directory', { mode: 0o600 });
  process.env.RW_CREDENTIALS_FILE = path.join(parent, '.credentials.yaml');
  const fake = new FakeDb([{ id: 'github', command: 'npx', env: { GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN, GITHUB_API_URL: 'https://api.github.com' } }]);
  try {
    const r = await migrateMcpSecrets(fake);
    assert.equal(r.applied, false, '一项都没搬成 ⇒ 不得落库');
    assert.deepEqual(r.migrated, []);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].name, 'GITHUB_PERSONAL_ACCESS_TOKEN');
    assert.equal(fake.calls.some((s) => /^UPDATE/.test(s)), false, '不得执行任何 UPDATE');
    assert.ok(fake.rows.get('mcp_servers').includes(TOKEN), '原配置里的明文仍在（迁移失败不破坏现状）');
    assert.equal(resolveEnv(fake.cfg()[0].env).GITHUB_PERSONAL_ACCESS_TOKEN, TOKEN, '而且它照旧生效，不静默降级成空');
  } finally { process.env.RW_CREDENTIALS_FILE = FILE; }
});

test('迁移部分成功：成功的搬走并落库，失败的原样留在 settings（不丢值）', async () => {
  // 先让文档不可写，把 A 项搬失败；再把路径换回可写，把 B 项搬成功
  const parent = path.join(TMP, 'blocked2');
  fs.writeFileSync(parent, 'x', { mode: 0o600 });
  process.env.RW_CREDENTIALS_FILE = path.join(parent, '.credentials.yaml');
  const fake = new FakeDb([{ id: 's', command: 'npx', env: { SOME_TOKEN: TOKEN } }]);
  const r1 = await migrateMcpSecrets(fake);
  assert.equal(r1.applied, false);
  process.env.RW_CREDENTIALS_FILE = FILE;
  const fake2 = new FakeDb([{ id: 's', command: 'npx', env: { SOME_TOKEN: TOKEN, OTHER_KEY: TOKEN2 } }]);
  const r2 = await migrateMcpSecrets(fake2);
  assert.deepEqual(r2.migrated, ['SOME_TOKEN', 'OTHER_KEY']);
  assert.equal(r2.failed.length, 0);
  assert.equal(JSON.stringify(fake2.rows.get('mcp_servers')).includes(TOKEN), false, '两项都搬干净了');
  assert.equal(getSecret('SOME_TOKEN'), TOKEN);
  assert.equal(getSecret('OTHER_KEY'), TOKEN2);
});

test('迁移：配置为空/非数组时什么都不做', async () => {
  assert.deepEqual((await migrateMcpSecrets(new FakeDb([]))).migrated, []);
  const fake = new FakeDb({ not: 'array' });
  assert.equal((await migrateMcpSecrets(fake)).applied, false);
  assert.deepEqual(await readMcpConfig(new FakeDb([])), []);
});

test('迁移脚本 scripts/migrate-c18.mjs：读→搬→换引用→再跑一遍零变化（幂等）', async () => {
  const fake = new FakeDb([{ id: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN } }]);
  const { main } = await import('../scripts/migrate-c18.mjs');
  const quiet = { log() {}, error() {} };
  const out1 = await main({ db: fake, log: quiet });
  assert.deepEqual(out1.migrated, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.equal(out1.exitCode, 0);
  assert.equal(fs.existsSync(FILE), true, '脚本必须真的写出凭据文档');
  assert.equal(fake.rows.get('mcp_servers').includes(TOKEN), false, '脚本必须把明文从 settings 里换掉');
  const out2 = await main({ db: fake, log: quiet });
  assert.deepEqual(out2.migrated, [], '第二遍无可搬');
  assert.deepEqual(out2.skipped, ['GITHUB_PERSONAL_ACCESS_TOKEN'], '第二遍认得出"已是引用"');
  assert.equal(out2.exitCode, 0);
});

// ── 端到端：MCP 真连一次，且日志/返回值里没有明文 ─────────────────────────────────────
test('端到端：MCP 从凭据文档取到密钥（真 spawn），日志与返回值里都不出现明文', async () => {
  setSecret(NAME, TOKEN);
  const fake = new FakeDb([{ id: 'c18', command: process.execPath, args: [ENV_ECHO, NAME], env: { [NAME]: CRED_PREFIX + NAME } }]);

  const logs = [];
  const realLog = console.log, realErr = console.error;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  console.error = (...a) => { logs.push(a.map(String).join(' ')); };
  try {
    const res = await connectConfiguredMcps(fake);
    assert.equal(res.length, 1);
    assert.equal(res[0].ok, true, '必须真的连上：' + JSON.stringify(res));
    assert.equal(res[0].tools, 1, 'env-echo 只暴露一个工具');
    const call = await callMcpTool('c18', 'env', { name: NAME });
    assert.equal(call.content, NAME + '=' + TOKEN, 'MCP 子进程必须拿到凭据文档里的真值');
    assert.equal(JSON.stringify(call).includes(TOKEN), true, '（真值只允许出现在工具返回值里，那是它的正当去处）');
  } finally {
    console.log = realLog; console.error = realErr;
    disconnectMcp('c18');
  }
  const blob = logs.join('\n');
  assert.equal(blob.includes(TOKEN), false, '日志里出现了明文：' + blob.slice(0, 400));
  assert.ok(logs.some((l) => l.includes('[mcp:c18]')), '夹具前提：确实产生了 mcp 日志（否则上一条断言是空的）');
});

test('端到端：外部程序把密钥喷到 stderr 也会被脱敏（真实泄漏路径）', async () => {
  setSecret(NAME, TOKEN);
  const fake = new FakeDb([]);
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  try {
    // env 里给的是**引用**（照真实路径先过 resolveEnv 再连）：这条同时证明
    // "引用解析"与"stderr 出口脱敏"两段都在真链路上生效
    await connectMcp('c18leak', process.execPath, [ENV_ECHO, NAME, '--leak-via-stdout'], resolveEnv({ [NAME]: CRED_PREFIX + NAME }));
    await new Promise((r) => setTimeout(r, 150)); // 等 stderr 那行落进日志
    assert.equal((await callMcpTool('c18leak', 'env', { name: NAME })).content, NAME + '=' + TOKEN, '子进程确实拿到了真值');
  } finally {
    console.log = realLog; disconnectMcp('c18leak');
  }
  const blob = logs.join('\n');
  assert.ok(blob.includes('startup-dump'), '夹具前提：外部进程确实喷了 stderr（否则这条断言是空的）');
  assert.equal(blob.includes(TOKEN), false, 'stderr 里的明文必须被替换：' + blob.slice(0, 400));
  assert.ok(blob.includes('[REDACTED:' + NAME + ']'), '替换成带名字的占位符，便于排障时知道被脱敏的是哪一项');
});

test('端到端：缺凭据时如实报错，不静默降级（服务不连、也不假装连上）', async () => {
  const fake = new FakeDb([{ id: 'c18missing', command: process.execPath, args: [ENV_ECHO, NAME], env: { [NAME]: CRED_PREFIX + 'NOT_CONFIGURED_C18' } }]);
  const res = await connectConfiguredMcps(fake);
  assert.equal(res[0].ok, false);
  assert.match(res[0].error, /缺少凭据 NOT_CONFIGURED_C18/);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
