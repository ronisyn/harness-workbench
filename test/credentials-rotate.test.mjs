// test/credentials-rotate.test.mjs - 凭据轮换（v0.3 §4.6「存放、引用、**轮换**」里最后那件，2026-09-16）
//
// 背景：`server/credentials.js` 的存放（0600 + 越权拒读）、引用（`__CRED__:` + 解析）、迁移都在，
// **轮换零命中**——`setSecret` 只被迁移调用，没有 API/UI/CLI，换钥匙只能手工编辑文件（v0.3 符合性核对 §1.3 ⑮）。
// 本夹具锁住"轮换"这一档的六件事：
//   ① 轮换＝写新值、旧值随即不可见，描述里**永远不含值**（返回值与日志两个出口）；
//   ② 原子性：写不进去时**旧值仍可用**、文档一字未动，并且**不落账**（"没换成功"不许在审计里留下换过的痕迹）；
//   ③ fingerprint 是"换没换"的可核对凭据（同值稳定、换值就变）；
//   ④ 落一条 `cred:rotate` 账，detail 只含 name + fingerprint；
//   ⑤ 落账失败**不改判轮换结果**（钥匙确实换了），但必须出声；
//   ⑥ CLI `scripts/rw-cred-rotate.mjs`：值只从 RW_CRED_VALUE/stdin 读，**值参数当场拒绝**（argv 会进 shell 历史与 ps）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-cred-rot-'));
const FILE = path.join(TMP, '.credentials.yaml');
// 必须在 import 之前设：credentials.js 每次调用都现算路径（不缓存），改它即可切换存储
process.env.RW_CREDENTIALS_FILE = FILE;

const { getSecret, setSecret, rotateSecret, secretFingerprint, credentialsFile, listSecretNames, CRED_PREFIX } =
  await import('../server/credentials.js');
const { main: cliMain } = await import('../scripts/rw-cred-rotate.mjs');

// 形状与真凭据一致（`ghp_` + 36 位 = 40），但不含任何真实密钥
const TOKEN = 'ghp_' + 'A'.repeat(36);
const TOKEN2 = 'ghp_' + 'B'.repeat(36);
const NAME = 'FAKE_ROTATE_TOKEN';
assert.ok(!process.env[NAME], '夹具前提：' + NAME + ' 不得已存在于进程环境里');

const reset = () => { for (const f of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, f), { force: true, recursive: true }); };
test.beforeEach(reset);

/**
 * 夹具假**存储**（2026-09-17 起审计写口走 `storage.audit.append`，原来那版"假库挡 INSERT"的 FakeDb 随之删掉）：
 * 只认 `audit.append` 一种调用，其余一律抛错（免得夹具悄悄假装支持了什么）；`fail` 用来模拟"审计写不进去"。
 * ⚠️ 为什么必须注入它：写口在 `rotateSecret` 里是 `(store || storage)`——**不注入就等于写进真库**
 * （2026-09-16 实测：只注入 `db` 时这条夹具把 12 行 `cred:rotate` 写进了共享库 rw_test，见 C-65）。
 */
class FakeStore {
  constructor({ fail = null } = {}) { this.appends = []; this.fail = fail; }
  get audit() {
    const self = this;
    return {
      async append(f) {
        if (self.fail) throw new Error(self.fail);
        self.appends.push(f);
        return { id: self.appends.length };
      },
    };
  }
  inserts() { return this.appends; }
}

/** 安静地收集 log/console 输出（同时检查"日志里没有明文"）。 */
function capture() {
  const lines = [];
  const push = (...a) => { lines.push(a.map(String).join(' ')); };
  const log = { log: push, error: push };
  const realErr = console.error;
  console.error = push;
  return { lines, log, restore: () => { console.error = realErr; }, text: () => lines.join('\n') };
}

// ── ① 轮换本体 ────────────────────────────────────────────────────────────────────
test('轮换＝写新值、旧值不再可见；返回的描述不含值（只有 name/updatedAt/fingerprint）', async () => {
  setSecret(NAME, TOKEN);
  assert.equal(getSecret(NAME), TOKEN, '前置：旧值在位');
  const r = await rotateSecret(NAME, TOKEN2);
  assert.deepEqual(Object.keys(r).sort(), ['fingerprint', 'name', 'updatedAt'], '描述的形状是这三样——多一样都可能带出值');
  assert.equal(r.name, NAME);
  assert.equal(JSON.stringify(r).includes(TOKEN2), false, '返回值里不得出现新值');
  assert.equal(JSON.stringify(r).includes(TOKEN), false, '返回值里也不得出现旧值');
  assert.equal(getSecret(NAME), TOKEN2, '换完取到的是新值');
  assert.equal(getSecret(NAME).includes(TOKEN), false, '旧值不再可见（无缓存要作废：getSecret 每次现取）');
  assert.equal(fs.readFileSync(FILE, 'utf8').includes(TOKEN), false, '文档里旧值那一行已被整份替换掉');
  assert.deepEqual(listSecretNames(), [NAME], '轮换不新增行（不是"再存一把"）');
  assert.ok(!Number.isNaN(Date.parse(r.updatedAt)), 'updatedAt 必须是个能解析的时间：' + r.updatedAt);
});

test('未配置过的名字也能轮换（＝首次写入）：不为此发明一条"必须先存在"的规则', async () => {
  const r = await rotateSecret(NAME, TOKEN);
  assert.equal(getSecret(NAME), TOKEN);
  assert.equal(typeof r.fingerprint, 'string');
});

test('连续轮换：每次旧值都不可见，文档里始终只有一行', async () => {
  setSecret(NAME, TOKEN);
  await rotateSecret(NAME, TOKEN2);
  const third = 'ghp_' + 'C'.repeat(36);
  await rotateSecret(NAME, third);
  assert.equal(getSecret(NAME), third);
  assert.equal(fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.startsWith(NAME + ':')).length, 1, '只有一行：轮换是替换，不是追加');
});

// ── ② 原子性：写失败时旧值仍可用、且不落账 ────────────────────────────────────────────
test('原子性：写新值这一步失败 ⇒ 抛错、旧值仍可用、文档一字未动、**不落账**', async () => {
  setSecret(NAME, TOKEN);
  const before = fs.readFileSync(FILE, 'utf8');
  const store = new FakeStore();
  // 只让"写新值"这一次写盘失败：拦掉**内容里含新值**的那次 `fs.writeFileSync`。
  // 为什么不用"把 tmp 路径占住"那一招（本仓既有夹具的写法）：它会让**任何**一次写入都失败，
  // 于是"先删旧值、再写新值"这种非原子实现照样活得下来（它删旧值那一步同样写不进去），
  // 夹具就分辨不出"原子替换"和"先删后写"——按内容拦只打中新值那一次写入，两种实现才分得开。
  const real = fs.writeFileSync;
  fs.writeFileSync = (p, data, ...rest) => {
    if (String(data).includes(TOKEN2)) throw new Error('模拟写盘失败');
    return real(p, data, ...rest);
  };
  try {
    await assert.rejects(() => rotateSecret(NAME, TOKEN2, { db: {}, store }), /模拟写盘失败/, '写失败必须如实抛错，不许假装换好了');
  } finally { fs.writeFileSync = real; }
  assert.equal(getSecret(NAME), TOKEN, '旧值仍可用（rename 语义下不存在"旧值已作废、新值还没到"的中间态）');
  assert.equal(fs.readFileSync(FILE, 'utf8'), before, '文档逐字节未动');
  assert.deepEqual(store.inserts(), [], '没换成功就不许落账：审计里不能留下"换过"的痕迹');
  // 障碍清掉后同一条命令能成（证明上一条失败的原因就是那个写入障碍，不是别的东西）
  const r = await rotateSecret(NAME, TOKEN2, { db: {}, store });
  assert.equal(getSecret(NAME), TOKEN2);
  assert.equal(store.inserts().length, 1, '这次才落账');
  assert.equal(r.fingerprint, secretFingerprint(TOKEN2));
});

test('轮换复用 setSecret 的全部判据：空值/非法名/被启动环境遮蔽的名字一律拒绝，且旧值不动', async () => {
  setSecret(NAME, TOKEN);
  await assert.rejects(() => rotateSecret(NAME, ''), /不得为空/);
  await assert.rejects(() => rotateSecret('有中文名', TOKEN2), /凭据名非法/);
  assert.equal(getSecret(NAME), TOKEN, '被拒的轮换不许动到旧值');
  process.env[NAME] = 'from-launch-env';
  try {
    await assert.rejects(() => rotateSecret(NAME, TOKEN2), /由启动环境提供/, '被 env 遮蔽时换文件是白换：新值根本不会生效，必须拒绝');
  } finally { delete process.env[NAME]; }
  assert.equal(getSecret(NAME), TOKEN);
});

// ── ③ fingerprint ───────────────────────────────────────────────────────────────
test('fingerprint：8 位十六进制、同值稳定、换值就变（"换没换"就靠它核对）', async () => {
  assert.match(secretFingerprint(TOKEN), /^[0-9a-f]{8}$/);
  assert.equal(secretFingerprint(TOKEN), secretFingerprint(TOKEN), '同一个值必须得到同一个指纹');
  assert.notEqual(secretFingerprint(TOKEN), secretFingerprint(TOKEN2));
  assert.notEqual(secretFingerprint(TOKEN), secretFingerprint(TOKEN + 'x'), '差一个字符也必须变');
  assert.equal(secretFingerprint(TOKEN).includes(TOKEN), false);
  setSecret(NAME, TOKEN);
  const a = await rotateSecret(NAME, TOKEN2);
  const b = await rotateSecret(NAME, TOKEN);
  assert.notEqual(a.fingerprint, b.fingerprint, '换回去了 ⇒ 指纹回到第一次的形态（可核对"换的是哪一把"）');
  assert.equal(b.fingerprint, secretFingerprint(TOKEN));
});

// ── ④⑤ 落账 ─────────────────────────────────────────────────────────────────────
test('落账：cred:rotate 一条，detail 只含 name 与 fingerprint，绝不含值', async () => {
  setSecret(NAME, TOKEN);
  const store = new FakeStore();
  const r = await rotateSecret(NAME, TOKEN2, { db: {}, store, accountId: 7 });
  assert.equal(store.inserts().length, 1);
  const [fields] = store.inserts();
  assert.deepEqual(fields, { accountId: 7, action: 'cred:rotate', detail: 'name=' + NAME + ' fingerprint=' + r.fingerprint });
  assert.equal(JSON.stringify(fields).includes(TOKEN2), false, '账本里绝不能出现明文');
  // 不传 accountId（CLI 场景：没有会话/用户）⇒ null，而不是 0 或 undefined 混进列
  const store2 = new FakeStore();
  await rotateSecret(NAME, TOKEN, { db: {}, store: store2 });
  assert.equal(store2.inserts()[0].accountId, null);
});

test('不传 db 就不落账（本模块不 import db.js：凭据文档的读写不依赖"库连得上"）', async () => {
  setSecret(NAME, TOKEN);
  const r = await rotateSecret(NAME, TOKEN2);
  assert.equal(typeof r.fingerprint, 'string');
  assert.equal(getSecret(NAME), TOKEN2);
});

test('落账失败不改判轮换结果：钥匙确实换了、调用方不抛错，但必须出声（且不出明文）', async () => {
  setSecret(NAME, TOKEN);
  const cap = capture();
  let r;
  try {
    r = await rotateSecret(NAME, TOKEN2, { db: {}, store: new FakeStore({ fail: 'audit down' }) });
  } finally { cap.restore(); }
  assert.equal(r.fingerprint, secretFingerprint(TOKEN2), '返回的是"换成了"的描述');
  assert.equal(getSecret(NAME), TOKEN2, '轮换已经生效——报失败会诱发复跑（第二次换的是同一把，纯属白折腾）');
  assert.match(cap.text(), /\[cred\] 轮换落账失败/, '漏账必须出声（静默 catch 是本仓库栽过两次的坑）');
  assert.equal(cap.text().includes(TOKEN2), false, '日志里不得出现明文：' + cap.text());
  assert.equal(cap.text().includes(TOKEN), false);
});

// ── ⑥ CLI ───────────────────────────────────────────────────────────────────────
test('CLI：值从 RW_CRED_VALUE 读，落一条账，输出里没有明文、也不含值参数', async () => {
  setSecret(NAME, TOKEN);
  const store = new FakeStore();
  const cap = capture();
  let out;
  try {
    out = await cliMain({ db: {}, store, log: cap.log, argv: ['--name', NAME], env: { RW_CRED_VALUE: TOKEN2 } });
  } finally { cap.restore(); }
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.result.name, NAME);
  assert.equal(getSecret(NAME), TOKEN2, 'CLI 真的换了钥匙');
  assert.equal(store.inserts().length, 1, 'CLI 路径也落账');
  assert.equal(store.inserts()[0].action, 'cred:rotate');
  assert.match(cap.text(), new RegExp('fingerprint=' + out.result.fingerprint));
  assert.equal(cap.text().includes(TOKEN2), false, 'CLI 输出里不得出现明文：' + cap.text());
  assert.equal(cap.text().includes(credentialsFile()), true, '要打印凭据文档位置（排障第一件事）');
  assert.equal(cap.text().includes(CRED_PREFIX + NAME), true, '要说明配置里存的仍是引用');
});

test('CLI：值从 stdin 读（管道那条路）——**只剥一个**行尾换行，多出来的换行是值的一部分', async () => {
  // 为什么用"两个换行"来验：`echo` 会补一个换行，去掉它是应该的；去多了就是在改值。
  // 换行在文档里被 escape 成 `\n` 两个字符，所以这个用例同时穿过"写→读→还原"整条路。
  const out = await cliMain({ db: {}, store: new FakeStore(), log: { log() {}, error() {} }, argv: ['--name', NAME], env: {}, readStdin: async () => 'tok en\n\n' });
  assert.equal(out.exitCode, 0);
  assert.equal(getSecret(NAME), 'tok en\n', '只剥掉一个行尾换行（若实现里写了 trim，这里会变成 "tok en"）');
});

test('（现状登记，非本次改动）行式文档格式读回时会 trim 行的首尾空白 ⇒ 值的首尾空格存不住', async () => {
  // credentials.js 的 readStore 对每一行做 `line.trim()`（行式格式的既有做法），所以值里**首尾**的空格
  // 存进去也读不回来（中间的空格不受影响）。token/URL 这类值不受影响，但"CLI 没 trim"不代表"空格一定进得去"——
  // 这个区别只能靠夹具说清楚，本轮不顺手改格式（改它等于换存储格式，属于另一件事）。
  await cliMain({ db: {}, store: new FakeStore(), log: { log() {}, error() {} }, argv: ['--name', NAME], env: {}, readStdin: async () => '  spaced  \n' });
  assert.equal(getSecret(NAME), 'spaced');
});

test('CLI：**值参数当场拒绝**（argv 会进 shell 历史与 ps），退出码 2 且一个字都不写', async () => {
  await assert.rejects(
    () => cliMain({ db: {}, store: new FakeStore(), log: { log() {}, error() {} }, argv: ['--name', NAME, '--value=' + TOKEN2], env: {} }),
    /不认识的参数：--value/, '把值写在命令行上必须被拦下');
  assert.equal(fs.existsSync(FILE), false, '被拒的用法不许碰凭据文档');
  await assert.rejects(() => cliMain({ log: { log() {}, error() {} }, argv: [], env: {} }), /缺少 --name/);
  await assert.rejects(
    () => cliMain({ log: { log() {}, error() {} }, argv: ['--name', NAME], env: {}, readStdin: async () => '' }),
    /没读到新值/);
});

test('CLI：轮换失败时如实抛错（旧值仍在）——入口不吞错', async () => {
  setSecret(NAME, TOKEN);
  const tmpPath = FILE + '.' + process.pid + '.tmp';
  fs.mkdirSync(tmpPath);
  try {
    await assert.rejects(
      () => cliMain({ db: {}, store: new FakeStore(), log: { log() {}, error() {} }, argv: ['--name', NAME], env: { RW_CRED_VALUE: TOKEN2 } }),
      undefined, '写失败必须冒到调用方（直接执行时由入口转成退出码 1）');
    assert.equal(getSecret(NAME), TOKEN, '旧值仍可用');
  } finally { fs.rmSync(tmpPath, { recursive: true, force: true }); }
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
