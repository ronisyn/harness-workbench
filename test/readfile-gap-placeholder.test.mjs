// test/readfile-gap-placeholder.test.mjs - 夹具：read_file_range 的「跳过 N 字符」占位只在**真的跳过内容**时才写
//
// 实测证据（audit_log，2026-09-15，conv=625，同一个文件 scripts/cohort.mjs）：
//   #11935  工具返回的 content 以 `…[已跳过上文给出过的 0 字符]…` 开头 —— **跳过 0 个字符也写了占位**，
//           模型看到的是"跳过了 0 个字符"这种噪声（内容是原样给出的，占位毫无信息量）；
//   #11941  同一文件、offset=0/length=2200：说明行写「有 2000 字符在本会话上文已给出」，
//           正文 `…[已跳过上文给出过的 2000 字符]…` —— 这一条是**对的**，反过来钉住"跳过 >0 时必须写、数字要对"。
//   （#11952 是同文件全段覆盖 → 走"极短回执"另一条路径，与本判据无关。）
//
// 判据只有一处（server/tools/index.js 的 read_file_range）：那个数字是 `s > off ? s - off : 0`。
// 当"未覆盖段"的起点 s 就等于本次请求的起点 off 时，前面**没有任何东西被跳过** ⇒ 不该写占位。
//
// 本夹具不读代码怎么写的，只看**返回的 content**：
//   ① 跳过 0 字符 ⇒ 不出现占位，说明行之后就是原样内容
//   ② 跳过 >0   ⇒ 出现占位、且数字等于真跳过的字符数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS } from '../server/tools/index.js';
import { clearReadCache } from '../server/readcache.js';

const TOOL = TOOLS.find((t) => t.name === 'read_file_range');
const PLACEHOLDER = /…\[已跳过上文给出过的 (\d+) 字符\]…/g;

// 2460 字节：60 行 × 40 字符 + 换行（每行开头是可定位的序号）
const BODY = Array.from({ length: 60 }, (_, i) => String(i).padStart(3, '0') + '-abcdefghijklmnopqrstuvwxyz0123456789').join('\n');

function tmpFile() {
  const p = path.join(os.tmpdir(), 'rw-gap-' + Math.random().toString(36).slice(2) + '.txt');
  fs.writeFileSync(p, BODY, 'utf8');
  return p;
}

test('占位①：未覆盖段从请求起点开始（跳过 0 字符）⇒ 不写占位，历史保持原样', async () => {
  assert.ok(TOOL, 'read_file_range 必须已注册（注册不上＝夹具没跑起来，不是通过）');
  const cid = 'fixture-gap-zero'; clearReadCache(cid);
  const p = tmpFile();
  try {
    // 先读**后半段**（记下区间 [1500,2000)），再从头读 0–2000 ⇒ 未覆盖段 = [0,1500)，起点正好 = 本次 off=0
    await TOOL.run({ path: p, offset: 1500, length: 500 }, { conversationId: cid });
    const second = await TOOL.run({ path: p, offset: 0, length: 2000 }, { conversationId: cid });
    assert.notEqual(second.deduped, true, '不是整段重复，必须真给内容');
    assert.doesNotMatch(second.content, /已跳过上文给出过的 0 字符/, '跳过 0 字符时不得写占位（#11935 的噪声）');
    assert.deepEqual([...second.content.matchAll(PLACEHOLDER)], [], '本次不该出现任何占位');
    // "历史保持原样"：说明行之后应当**就是**原始内容，前面不再插任何东西
    const payload = second.content.slice(second.content.indexOf(BODY.slice(0, 20)));
    assert.equal(payload, BODY.slice(0, 1500), '说明行之后应直接是原样内容');
  } finally { fs.unlinkSync(p); }
});

test('占位②：真的跳过了内容 ⇒ 写占位，且数字等于真跳过的字符数', async () => {
  assert.ok(TOOL, 'read_file_range 必须已注册（注册不上＝夹具没跑起来，不是通过）');
  const cid = 'fixture-gap-positive'; clearReadCache(cid);
  const p = tmpFile();
  try {
    // 先读 0–1000（记下），再读 0–2000 ⇒ 未覆盖段 = [1000,2000) ⇒ 真跳过 1000 字符
    await TOOL.run({ path: p, offset: 0, length: 1000 }, { conversationId: cid });
    const second = await TOOL.run({ path: p, offset: 0, length: 2000 }, { conversationId: cid });
    const m = [...second.content.matchAll(PLACEHOLDER)];
    assert.equal(m.length, 1, '真跳过了内容 ⇒ 必须且只写一个占位');
    assert.equal(m[0][1], '1000', '占位里的数字必须等于真跳过的字符数');
    assert.ok(second.content.includes('…[已跳过上文给出过的 1000 字符]…\n' + BODY.slice(1000, 2000)),
      '占位之后必须紧跟被补出来的那段内容');
  } finally { fs.unlinkSync(p); }
});
