// test/jsonfile-migration.test.mjs —— JSON 存储（`rw-store-json`）**迁移链**的夹具（依据 v0.3 §4.9，2026-09-16）
//
// 为什么要有它：第二个存储实现此前只有 `format`/`version` 两个字段，**没有任何迁移步**——版本号涨了没人负责
// 把老文件升上来，"带迁移链"这半句在存储侧是空的。这类注册点最容易写成"看着有、其实不拦人"：跳步能注册、
// 缺步能跑、旧文件被当成当前版本硬读、新版本被硬读。这四条都是**静默的数据错误**（出事那天没有任何报错），
// 所以夹具的价值全在负例。形状照 `test/session-format-migration.test.mjs`（会话侧先做的那一半），这里锁五件事：
//   ① 跳步/倒步/重复起点/缺函数必须在**注册时**就抛错；链有缺口/有多余步必须在**读任何文件之前**抛错；
//   ② **"首版、无迁移步"是合法状态**：当前只有 v1 ⇒ 链为空、启动校验通过（这不是"缺一步"）；
//   ③ 合成的一条 **v0→v1** 步证明"打开旧文件 ⇒ 沿链逐步迁移 ⇒ 写回"真的走得通：只读打开也落盘、重启后
//      不重复迁移（幂等）、迁移是纯函数、文件里不留旧字段与临时文件；
//   ④ 比本代码**新**的版本必须**显式拒绝且一个字节都不写**（不硬读、不降级）；
//   ⑤ 迁移步自己抛错 ⇒ 显式报"哪一步拒绝了哪个版本"，不许看起来像"文件坏了"。
// **合成步只活在本夹具里**（用注册点返回的注销函数还原），不进产品代码——当前没有 v0 的存储文件，写它没有
// 第二个使用者。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerStoreMigration, storeMigrations, validateStoreMigrationChain, planStoreMigration,
  migrateStoreDoc, createJsonFileStorage,
  StoreFormatUnsupportedMigrationError, STORE_FORMAT, STORE_FORMAT_VERSION, STORE_FORMAT_FIRST_VERSION,
} from '../server/storage/jsonfile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-store-mig-'));
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
const tmpFile = (tag) => path.join(TMP, tag + '-' + Math.random().toString(36).slice(2) + '.json');
/** 目录里剩下的临时文件（写盘走"先写临时文件再 rename"，所以**正常情况下恒为空**） */
const tmpLeftovers = () => fs.readdirSync(TMP).filter((f) => f.endsWith('.tmp'));

/** 合成链用的一步（形状与注册表里的一致；校验器接受这种裸数组，见 migrations.js 的 validateChain 同款用法） */
const step = (from) => ({ fromVersion: from, toVersion: from + 1, name: 'v' + from + '-to-v' + (from + 1), fn: (d) => d });

// 合成的 v0 形状（**只在本夹具里**）：字段名与 v1 故意不同（会话用 `name` 而不是 `title`、消息用 `text`
// 而不是 `content`），这样"读得到标题/正文"只可能是因为**真的迁移过**，而不是碰巧能读。
const v0doc = () => ({
  format: STORE_FORMAT,
  version: 0,
  counters: { conversations: 1, messages: 1 },
  tables: {
    conversations: { 1: { id: 1, accountId: 7, name: 'v0 旧标题', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' } },
    messages: { 1: { id: 1, conversationId: 1, role: 'user', text: '你好', createdAt: '2026-09-01T00:00:00.000Z' } },
  },
});

/** v0→v1：`name` → `title`、`text` → `content`（迁移步必须是纯函数：不改入参） */
function v0ToV1(doc) {
  const rename = (rows, from, to) => Object.fromEntries(Object.entries(rows || {}).map(([k, r]) => {
    const { [from]: old, ...rest } = r;
    return [k, { ...rest, [to]: old }];
  }));
  return {
    ...doc,
    tables: {
      ...doc.tables,
      conversations: rename(doc.tables.conversations, 'name', 'title'),
      messages: rename(doc.tables.messages, 'text', 'content'),
    },
  };
}

// ---------------- ② 首版无步 ----------------
test('正例：当前只有 v1 ⇒ 链为空是**合法状态**（首版、无迁移步），启动校验通过', () => {
  assert.equal(STORE_FORMAT_VERSION, 1);
  assert.equal(STORE_FORMAT_FIRST_VERSION, 1);
  assert.deepEqual(storeMigrations(), [], 'v1 是首版：没有任何更旧的版本存在过 ⇒ 没有迁移步可写');
  assert.equal(validateStoreMigrationChain(), true, '"链为空"不是缺口（否则服务一启动就抛）');
  // 当前版本的文件**不走迁移**（照 DSH ③：current 直接走 codec）——原样返回，零开销
  const cur = { format: STORE_FORMAT, version: STORE_FORMAT_VERSION, counters: {}, tables: {} };
  assert.equal(migrateStoreDoc(cur), cur);
});

test('正例：打开既有 v1 文件不报错、内容**逐字不变**（链为空 ⇒ 没有迁移，也就没有写回）', async () => {
  const file = tmpFile('v1-asis');
  const first = createJsonFileStorage({ file });
  await first.settings.set('k', { a: 1 });
  await first.conversations.create({ accountId: 1, title: 'v1 原样' });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(before).version, STORE_FORMAT_VERSION, '文件里写的版本就是当前版本');

  const second = createJsonFileStorage({ file });   // 新实例 ＝ 重启（内存态没了，只剩文件）
  assert.deepEqual(await second.settings.get('k'), { a: 1 });
  assert.equal((await second.conversations.get(1)).title, 'v1 原样');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'v1 文件不该被重写：只读打开不许改动一个字节');
  assert.deepEqual(tmpLeftovers(), []);
});

// ---------------- ① 相邻步（注册时校验） ----------------
test('负例：跳步/倒步/非法版本号/缺函数必须在**注册时**抛错，且不留半条链', () => {
  assert.throws(() => registerStoreMigration(0, 2, v0ToV1), /必须相邻/);
  assert.throws(() => registerStoreMigration(0, 1.5, v0ToV1), /必须相邻|非负整数/);
  assert.throws(() => registerStoreMigration(1, 1, v0ToV1), /必须相邻/);
  assert.throws(() => registerStoreMigration(2, 1, v0ToV1), /必须相邻/);
  assert.throws(() => registerStoreMigration(-1, 0, v0ToV1), /非负整数/);
  assert.throws(() => registerStoreMigration('0', 1, v0ToV1), /非负整数/);
  assert.throws(() => registerStoreMigration(0, 1, '不是函数'), /缺少迁移函数/);
  assert.deepEqual(storeMigrations(), [], '注册失败不得在链里留下半条');
});

test('负例：同一起点重复注册必须抛错（同一版本不能有两条出路）', () => {
  const off = registerStoreMigration(0, 1, v0ToV1);
  try {
    assert.throws(() => registerStoreMigration(0, 1, v0ToV1), /重复注册/);
    assert.equal(storeMigrations().length, 1);
  } finally { off(); }
  assert.deepEqual(storeMigrations(), [], '注销函数必须把链还原干净（夹具靠它不污染别的用例）');
});

// ---------------- ① 链缺口 / 多余步 / 坏链 ----------------
test('负例：链有缺口必须抛错（合成链 base=1/head=3 缺 v1→v2）', () => {
  const gap = [step(0), step(2)];
  assert.throws(() => validateStoreMigrationChain(gap, { base: 1, head: 3 }), /有缺口：缺 v1→v2/);
  // 同一份链在"规划"里也必须显式报，不允许静默按当前版本读
  assert.throws(() => planStoreMigration(1, { steps: gap, head: 3 }), (e) => {
    assert.ok(e instanceof StoreFormatUnsupportedMigrationError);
    assert.match(e.message, /没有 v1→v3 的迁移/);
    assert.match(e.message, /缺这一步：v1→v2/);
    return true;
  });
  // 正例对照（否则上面两条可能只是"这个函数永远不会通过"）
  assert.equal(validateStoreMigrationChain([step(0), step(1), step(2)], { base: 1, head: 3 }), true);
  assert.deepEqual(planStoreMigration(1, { steps: [step(1), step(2)], head: 3 }).map((s) => s.name), ['v1-to-v2', 'v2-to-v3']);
});

test('负例：把坏链直接交给校验器也要拦（不相邻 / 重复起点 / 缺函数 / 不是数组）', () => {
  assert.throws(() => validateStoreMigrationChain([step(1), { fromVersion: 2, toVersion: 4, fn: () => {} }]), /必须相邻/);
  assert.throws(() => validateStoreMigrationChain([step(1), step(1)], { base: 1, head: 3 }), /重复/);
  assert.throws(() => validateStoreMigrationChain([{ fromVersion: 1, toVersion: 2 }]), /缺少迁移函数/);
  assert.throws(() => validateStoreMigrationChain('不是数组'), /必须是数组/);
});

test('负例：指向未来的多余步必须抛错（改了版本号却先注册了下一步 / 忘了改版本号）', () => {
  const off = registerStoreMigration(1, 2, (d) => d);   // 而 head 还是 1
  try {
    assert.throws(() => validateStoreMigrationChain(), /多余步.*v1/);
  } finally { off(); }
  // v0 的文件在**没有 v0→v1 这一步**时一律拒绝（"缺步"这一档的唯一出口）
  assert.throws(() => planStoreMigration(0), (e) => {
    assert.ok(e instanceof StoreFormatUnsupportedMigrationError);
    assert.match(e.message, /没有 v0→v1 的迁移/);
    return true;
  });
});

test('源码级：链校验在模块顶层调用（import 即校验；而选择点在启动时就 import 本模块）', () => {
  assert.match(read('server/storage/jsonfile.js'), /^validateStoreMigrationChain\(\);$/m,
    '链校验必须在模块顶层——挪进函数里就变成"跑到某条路径上才发现链坏了"');
  assert.match(read('server/storage/index.js'), /import \{ createJsonFileStorage \} from '\.\/jsonfile\.js'/,
    'jsonfile 由存储选择点在启动时 import ⇒ 上面的顶层校验就是启动校验');
});

// ---------------- ③ 迁移正路（合成 v0→v1） ----------------
test('正例：注册 v0→v1 后，打开 v0 文件 ⇒ 逐步迁移 + 写回；再打开不重复迁移（幂等）', async () => {
  const file = tmpFile('v0-upgrade');
  fs.writeFileSync(file, JSON.stringify(v0doc(), null, 2), 'utf8');
  const before = v0doc();
  let steps = 0;

  // 对照（注册之前）：v0 文件**没有那一步** ⇒ 显式拒绝，且一个字节都不写
  const raw0 = fs.readFileSync(file, 'utf8');
  await assert.rejects(() => createJsonFileStorage({ file }).settings.get('k'), (e) => {
    assert.ok(e instanceof StoreFormatUnsupportedMigrationError);
    assert.match(e.message, /没有 v0→v1 的迁移/);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), raw0, '拒绝路径不许写盘');
  assert.deepEqual(tmpLeftovers(), []);

  const off = registerStoreMigration(0, 1, (d) => { steps++; return v0ToV1(d); }, { name: 'v0-to-v1' });
  try {
    assert.equal(validateStoreMigrationChain(), true, '合成的相邻链（底盘 v0、顶端 v1）本身必须合法');

    // **只读打开**：迁移完当场写回（不是"等下一次有人写"）
    const first = createJsonFileStorage({ file });
    assert.equal((await first.conversations.get(1)).title, 'v0 旧标题', '读得到标题 ⇒ 真的迁移过（v0 里这个字段叫 name）');
    assert.deepEqual((await first.messages.list(1, 10)).map((r) => r.content), ['你好'], 'v0 的 text → v1 的 content');
    assert.equal(steps, 1, '一步一版：只走了 v0→v1 这一趟');

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.version, STORE_FORMAT_VERSION, '只读打开也要把文件升到当前版本');
    assert.equal(onDisk.tables.conversations['1'].title, 'v0 旧标题');
    assert.equal('name' in onDisk.tables.conversations['1'], false, 'v0 的旧字段不许留在文件里');
    assert.equal(onDisk.tables.messages['1'].content, '你好');
    assert.deepEqual(tmpLeftovers(), [], '临时文件必须被 rename 掉（迁移写回也走同一套机制）');

    // 重启（新实例）再读一次：文件已是 v1 ⇒ **不再迁移**，内容仍正确
    const second = createJsonFileStorage({ file });
    assert.equal((await second.conversations.get(1)).title, 'v0 旧标题');
    assert.deepEqual((await second.messages.list(1, 10)).map((r) => r.content), ['你好']);
    assert.equal(steps, 1, '同一版本再打开不许重复迁移（幂等）');

    // 迁移是**纯函数**：入参一个字都不许改（调用方可能还持有那份文件对象）
    assert.deepEqual(before, v0doc(), 'migrateStoreDoc 不得就地改写入参');
  } finally { off(); }

  // 注销 ⇒ 回到"链为空"：文件现在真的是 v1（否则这里会被当成 v0 拒绝掉——写回这条断言也就同时被验了）
  assert.deepEqual(storeMigrations(), []);
  const third = createJsonFileStorage({ file });
  assert.equal((await third.conversations.get(1)).title, 'v0 旧标题', '写回之后，链为空也照样读得动 ⇒ 文件确实已经是 v1');
});

test('正例：链给每一步**盖版本号**（步自己写错 version 也不会让链错位）', () => {
  const off = registerStoreMigration(0, 1, (d) => ({ ...v0ToV1(d), version: 99 }));
  try {
    assert.equal(migrateStoreDoc(v0doc()).version, 1);
  } finally { off(); }
});

test('正例：迁移写回不与**串行化的写链**打架（迁移之后 24 个并发追加一条不少）', async () => {
  const file = tmpFile('v0-then-concurrent');
  fs.writeFileSync(file, JSON.stringify(v0doc(), null, 2), 'utf8');
  const off = registerStoreMigration(0, 1, v0ToV1);
  try {
    const s = createJsonFileStorage({ file });   // 第一次读 holder.doc ⇒ 同步迁移 + 写回，之后才是排队写
    await Promise.all(Array.from({ length: 24 }, (_, i) => s.messages.append({ conversationId: 1, role: 'user', content: 'm' + i })));
    const want = ['你好', ...Array.from({ length: 24 }, (_, i) => 'm' + i)];
    assert.deepEqual((await s.messages.list(1, 100)).map((r) => r.content), want, '迁移写回之后的并发写一条不少、顺序不乱');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.version, STORE_FORMAT_VERSION);
    assert.equal(Object.keys(onDisk.tables.messages).length, 25, '落盘的快照里迁移结果与并发写都在');
    assert.deepEqual((await createJsonFileStorage({ file }).messages.list(1, 100)).map((r) => r.content), want, '重启后仍逐条对得上');
    assert.deepEqual(tmpLeftovers(), []);
  } finally { off(); }
});

// ---------------- ④ 未来版本显式拒绝 ----------------
test('负例：文件版本比本代码新 ⇒ 显式拒绝，且**不写盘**（不许硬读、不许降级）', async () => {
  const file = tmpFile('future');
  const newer = STORE_FORMAT_VERSION + 1;
  const doc = { format: STORE_FORMAT, version: newer, counters: {}, tables: { settings: { k: { id: 'k', value: 1 } } } };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  const raw = fs.readFileSync(file, 'utf8');

  await assert.rejects(() => createJsonFileStorage({ file }).settings.get('k'), (e) => {
    assert.ok(e instanceof StoreFormatUnsupportedMigrationError, '要能与"文件坏了"区分开：这一档是"你的版本太新"');
    assert.match(e.message, /版本不认识/);
    assert.match(e.message, new RegExp('这份文件是 v' + newer));
    assert.match(e.message, new RegExp('本实现只认到 v' + STORE_FORMAT_VERSION));
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), raw, '拒绝路径一个字节都不许写（更不许把新版本文件改坏）');
  assert.deepEqual(tmpLeftovers(), []);
  // 规划层同一条判据（两份报错说的是同一件事：不降级硬读）
  assert.throws(() => planStoreMigration(newer), (e) => {
    assert.ok(e instanceof StoreFormatUnsupportedMigrationError);
    assert.match(e.message, new RegExp('更新的 v' + newer));
    return true;
  });
});

// ---------------- ⑤ 迁移步抛错 / 返回值不对 ----------------
test('负例：迁移步自己抛错 ⇒ 显式报"哪一步拒绝了哪个版本"（打开文件时同一条路径也要报得出来）', async () => {
  const file = tmpFile('step-throws');
  fs.writeFileSync(file, JSON.stringify(v0doc(), null, 2), 'utf8');
  const raw = fs.readFileSync(file, 'utf8');
  const off = registerStoreMigration(0, 1, () => { throw new TypeError('字段缺失'); }, { name: 'v0-to-v1' });
  try {
    assert.throws(() => migrateStoreDoc(v0doc()), (e) => {
      assert.ok(e instanceof StoreFormatUnsupportedMigrationError);
      assert.match(e.message, /迁移步 v0-to-v1 拒绝了这份 v0 存储文件/);
      assert.match(e.message, /字段缺失/);
      return true;
    });
    await assert.rejects(() => createJsonFileStorage({ file }).settings.get('k'), /迁移步 v0-to-v1 拒绝了这份 v0 存储文件/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw, '迁移失败不许留下半迁移的文件');
  } finally { off(); }
});

test('负例：迁移步必须返回存储文件对象（返回 null / 数组都要拦）', () => {
  const off = registerStoreMigration(0, 1, () => null);
  try {
    assert.throws(() => migrateStoreDoc(v0doc()), /必须返回存储文件对象（实际是 object）/);
  } finally { off(); }
  const off2 = registerStoreMigration(0, 1, () => []);
  try {
    assert.throws(() => migrateStoreDoc(v0doc()), /必须返回存储文件对象（实际是 array）/);
  } finally { off2(); }
});

// ---------------- 信封检查（两个入口共用一份） ----------------
test('信封检查先于版本判定：非对象 / 不是我们的格式 / 版本号不合法，三档分开报', () => {
  assert.throws(() => migrateStoreDoc('{"format":"rw-store-json"}'), /必须是 JSON 对象（实际是 string）/);
  assert.throws(() => migrateStoreDoc([v0doc()]), /必须是 JSON 对象（实际是 array）/);
  assert.throws(() => migrateStoreDoc({ ...v0doc(), format: 'rw-store-other' }), /存储文件格式不认识/);
  for (const bad of ['1', 1.5, -1, null, undefined]) {
    assert.throws(() => migrateStoreDoc({ ...v0doc(), version: bad }), /版本号不合法/);
  }
});
