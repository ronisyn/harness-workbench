// test/modelcaps.test.mjs - §4.3「模型能力声明（窗口/工具/视觉/思考）」三维的消费夹具（2026-09-17）
//
// 依据：v0.3 §4.3 那一行要求模型网关做「模型能力声明（窗口/工具/视觉/思考）+ 可切云端/客户网关/内网推理 + 断网降级」。
// 改造前的真实状态是**只有字段、没有消费方**：窗口那一维由 `server/modelwindow.js` 消费（`agent.js:397`），
// 工具/视觉/思考三维零消费方（`grep capabilities server/` 只命中 provider/market/表列；`index.js` 的
// `VISION_RE` 是按消息**文本**猜的，不是按声明）。
//
// 本文件的立场（与 test/modelwindow.test.mjs 同一条：判据不发明、缺失不假装）：
//   ① 三维的判定只有一处实现（`server/modelcaps.js`），这里直接打它 + 打网关的**发送前**行为；
//   ② 每一维都必须有**可观测后果**，不是"字段透出"就算完：
//        视觉：显式声明不支持 ⇒ 发图前抛错，且**一个请求都没发出去**（fetch 不被调用）；
//        工具：显式声明不支持 ⇒ 发出的 body 里 tools 为空数组（工具面根本没发给它）；
//        思考：显式声明不支持 ⇒ 思考增量**不转发**（onThink 收不到）、但**不静默丢**（返回值带丢弃字符数）；
//   ③ "未声明 ⇒ 维持改造前行为"必须逐维钉住（未声明不是"不支持"）。
//   ④ **2026-09-17 返工的核心（本文件最容易做错、也是最重要的一条）**：`capabilities` 是产品/UI **标签**数组，
//      不是排他性能力全集——"标签里没写 tool"**绝不等于**"不支持工具"。实测：deepseek 标签
//      `['chat','code','reasoning']`（无 'tool'）却一直在调工具。所以本文件的夹具分成两类：
//        · 缺标签类（`P_TOOL_NOTAG` / `P_VISION_NOTAG`）：**必须照发**（原样行为，一条都不许收窄）；
//        · 显式否定类（`providerLike(..., { capabilitiesDeclared: { tool: false } })`）：才允许收窄/拒发。
//   ⚠️ 内置清单里**没有一家**用过专用否定字段，所以"显式否定"那一半只能用 `providerLike`（modelcaps.js 导出的
//      夹具专用构造器，不改 providers.js、不注册任何东西）。真实厂商那半边用真清单（deepseek / ark）钉住。
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilitiesOf, canDo, imagesOf, visionRefusalMessage, capabilitiesReport,
  providerLike, CAP_DIMENSIONS, CAP_OVERRIDE_FIELD, USED_TOOL_FACE_PRUNED,
} from '../server/modelcaps.js';
import { chatOnce, chatOnceWithTools, chatStreamWithTools } from '../server/llm/gateway.js';
import { capabilityManifest, capabilitySummary } from '../server/capabilities.js';
import { PROVIDERS } from '../server/llm/providers.js';

// ---- 夹具用的厂商 stub（key 必须配，否则网关在"未配置 API Key"就抛了，测不到能力闸门）----
const KEYS = { 'fixture-vision-neg': 'k', 'fixture-vision-notag': 'k', 'fixture-vision-yes': 'k', 'fixture-nocaps': 'k', 'fixture-tool-neg': 'k', 'fixture-tool-neg2': 'k', 'fixture-tool-notag': 'k', 'fixture-tool-yes': 'k', 'fixture-reason-neg': 'k', 'fixture-reason-notag': 'k', 'fixture-reason-yes': 'k' };
const base = (id) => ({ base: 'http://fixture.invalid/v1', keyEnv: id, defaultModel: 'fixture-model-1', capabilities: ['chat'] });
// ── 视觉：显式否定 / 缺标签（真 deepseek 同形）/ 标签支持 ──
const P_VISION_NEG = providerLike('fixture-vision-neg', ['chat'], { ...base('fixture-vision-neg'), [CAP_OVERRIDE_FIELD]: { vision: false } });
const P_VISION_NOTAG = providerLike('fixture-vision-notag', ['chat', 'code', 'reasoning'], base('fixture-vision-notag')); // 与真 deepseek 同形：无 vision 标签
const P_VISION_YES = providerLike('fixture-vision-yes', ['chat', 'vision'], base('fixture-vision-yes'));
// ── 工具：显式否定 / **缺 'tool' 标签但一直用工具**（与真 deepseek 同形，返工的核心夹具）/ 标签支持 ──
const P_TOOL_NEG = providerLike('fixture-tool-neg', ['chat', 'vision'], { ...base('fixture-tool-neg'), [CAP_OVERRIDE_FIELD]: { tool: false } });
const P_TOOL_NOTAG = providerLike('fixture-tool-notag', ['chat', 'code', 'reasoning'], base('fixture-tool-notag')); // 无 'tool' 标签 ⇒ **照发**
const P_TOOL_YES = providerLike('fixture-tool-yes', ['chat', 'tool'], base('fixture-tool-yes'));
// ── 思考：显式否定 / 缺标签（照转）/ 标签支持 ──
const P_REASON_NEG = providerLike('fixture-reason-neg', ['chat', 'tool'], { ...base('fixture-reason-neg'), [CAP_OVERRIDE_FIELD]: { reasoning: false } });
const P_REASON_NOTAG = providerLike('fixture-reason-notag', ['chat', 'code'], base('fixture-reason-notag'));
const P_REASON_YES = providerLike('fixture-reason-yes', ['chat', 'reasoning'], base('fixture-reason-yes'));
const P_NOCAPS = providerLike('fixture-nocaps', null, { base: 'http://fixture.invalid/v1', keyEnv: 'fixture-nocaps', defaultModel: 'fixture-model-1' }); // 没写 capabilities 字段

// 为什么要把夹具厂商**注册进 PROVIDERS**：网关（`llm/gateway.js` 的 resolve → findProvider）只认注册表里的厂商，
// 这正是"厂商定义只有一处事实源"的体现——所以夹具也走同一条路，而不是给网关塞一条测试专用分支
// （那种"测试走另一条路"的做法会让夹具证明不了生产路径）。
// 作用域纪律：只在本夹具进程内临时挂上，`after` 里摘掉（`node --test` 每个文件一个进程，但仍按纪律还原）。
const FIXTURE_PROVIDERS = [P_VISION_NEG, P_VISION_NOTAG, P_VISION_YES, P_TOOL_NEG, P_TOOL_NOTAG, P_TOOL_YES, P_REASON_NEG, P_REASON_NOTAG, P_REASON_YES, P_NOCAPS];
const registeredIds = FIXTURE_PROVIDERS.map((p) => p.id);
for (const p of FIXTURE_PROVIDERS) { if (!PROVIDERS.some((x) => x.id === p.id)) PROVIDERS.push(p); }
after(() => {
  for (let i = PROVIDERS.length - 1; i >= 0; i--) if (registeredIds.includes(PROVIDERS[i].id)) PROVIDERS.splice(i, 1);
});

/** 一张图的用户消息（OpenAI 兼容多模态 part —— 网关的 ocr_image/view_image 与外部渠道都是这个形态） */
const imageMsg = () => [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: '识别' }] }];
const textMsg = () => [{ role: 'user', content: '你好' }];
const toolDef = (name) => ({ type: 'function', function: { name } });

/** 假 OpenAI 非流式响应（只为让 body 落地，不做任何真网络调用） */
const fakeOnce = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
/** 假 SSE 响应：可注入 reasoning_content 增量（正文块照常给一条，好断言"只是思考被拦、正文不受影响"） */
const fakeStream = (reasoning) => new Response([
  'data: ' + JSON.stringify({ choices: [{ delta: reasoning ? { reasoning_content: reasoning } : { reasoning_content: 'r' } }] }),
  'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
  'data: [DONE]',
  '',
].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** 造一个假读流：onThink 收到的每一块 */
const thinkSpy = () => { const seen = []; return { seen, fn: (t) => seen.push(t) }; };

// ---------------------------------------------------------------------------
// 一、字段来源与三态判定（先钉"判的是哪个词、缺失是什么语义"）
// ---------------------------------------------------------------------------
test('字段来源与三态：标签数组只给 true/null；**任何 provider 都不因缺标签而得到 false**', () => {
  // ── 返工锁（最重要的一条）：遍历**内置厂商**，三维里出现 false 就说明有人又把"缺标签"当否定了 ──
  // （夹具厂商不在扫描范围内：其中几家的专用否定字段里本来就写了 false，那是它们存在的理由）
  for (const p of PROVIDERS) {
    if (registeredIds.includes(p.id)) continue;
    const c = capabilitiesOf(p.id);
    assert.deepEqual(c.negated, [], p.id + ' 出现了显式否定 —— 今天没有任何内置厂商该有它');
    for (const dim of ['vision', 'tool', 'reasoning']) {
      assert.notEqual(c[dim], false, p.id + ' 的 ' + dim + ' 被判成 false —— 而 capabilities 是产品标签数组，'
        + '"缺标签"绝不等于"不支持"（deepseek/ark 没有 tool 标签却一直在用工具）。显式否定只能来自 ' + CAP_OVERRIDE_FIELD);
    }
  }
  // 实测复现（返工的那条）：deepseek 标签 ['chat','code','reasoning']（无 'tool'）⇒ tool 必须是 null，不是 false
  const deepseek = capabilitiesOf('deepseek', 'deepseek-v4-flash');
  assert.equal(deepseek.declared, true);
  assert.equal(deepseek.reasoning, true, 'deepseek 标签里有 reasoning ⇒ true');
  assert.equal(deepseek.tool, null, '标签里没 tool ⇒ **null（未声明）**，不是 false —— 我们一直在 deepseek 上调工具');
  assert.equal(deepseek.vision, null, '标签里没 vision ⇒ null（发图前闸门不该因此拒绝）');
  assert.deepEqual(deepseek.negated, [], '没有任何显式否定');
  const ark = capabilitiesOf('ark', 'doubao-seed-2-1-pro-260628'); // 标签 ['chat','vision','image','video']
  assert.equal(ark.vision, true, 'ark 标签里有 vision ⇒ true');
  assert.equal(ark.tool, null, 'ark 也没 tool 标签 ⇒ null（它在用工具）');
  // 三维键都在（缺一维就是漏判）
  assert.deepEqual(Object.keys(CAP_DIMENSIONS).sort(), ['reasoning', 'tool', 'vision']);
  assert.deepEqual(Object.keys(capabilitiesOf('ark')).filter((k) => ['vision', 'tool', 'reasoning'].includes(k)).sort(), ['reasoning', 'tool', 'vision']);

  // 显式否定（唯一能产生 false 的来源，用专用字段）
  const neg = capabilitiesOf(providerLike('x', ['chat'], { [CAP_OVERRIDE_FIELD]: { tool: false, vision: false } }));
  assert.equal(neg.tool, false);
  assert.equal(neg.vision, false);
  assert.equal(neg.reasoning, null, '只否定了两维 ⇒ 第三维仍是未声明');
  assert.deepEqual(neg.negated.sort(), ['tool', 'vision'], 'negated 要如实列出被显式否定的维');
  // 专用字段写 true ⇒ 正向（与标签同向）；形状异常 ⇒ 当没声明（不猜，猜错的方向是关掉能力）
  assert.equal(capabilitiesOf(providerLike('x', [], { [CAP_OVERRIDE_FIELD]: { tool: true } })).tool, true);
  assert.equal(capabilitiesOf(providerLike('x', [], { [CAP_OVERRIDE_FIELD]: 'tool:false' })).tool, null, '脏形状不得被解析成否定');
  assert.equal(capabilitiesOf(providerLike('x', [], { [CAP_OVERRIDE_FIELD]: ['tool'] })).tool, null);

  // 缺失：厂商**没写 capabilities 字段** ⇒ 三维全 null（未声明），且 declared=false
  const none = capabilitiesOf(P_NOCAPS, 'fixture-model-1');
  assert.equal(none.declared, false);
  assert.equal(none.vision, null);
  assert.equal(none.tool, null);
  assert.equal(none.reasoning, null);
  // null 与 false 是两件事（消费方的默认值全靠它）
  assert.notEqual(capabilitiesOf('deepseek').tool, capabilitiesOf(providerLike('x', [], { [CAP_OVERRIDE_FIELD]: { tool: false } })).tool);
  // 厂商 id 不认识：同样是"未声明"（不猜、不默认禁止）
  assert.equal(capabilitiesOf('no-such-provider-xyz', 'm').declared, false);
  assert.equal(capabilitiesOf('no-such-provider-xyz', 'm').vision, null);
  // canDo 只做映射，不塞默认值（默认值是消费方的决定）
  assert.equal(canDo(capabilitiesOf('ark'), 'vision'), true);
  assert.equal(canDo(capabilitiesOf('deepseek'), 'vision'), null, '缺标签 ⇒ null（不是 false）');
  assert.equal(canDo(neg, 'tool'), false);
  assert.equal(canDo(capabilitiesOf(P_NOCAPS), 'vision'), null);
  assert.equal(canDo(null, 'vision'), null);
  assert.equal(canDo(capabilitiesOf('ark'), 'not-a-dimension'), null);
});

test('imagesOf：判的是消息**结构**里的图 part，不猜文本（VISION_RE 那条路照旧不动）', () => {
  assert.deepEqual(imagesOf(textMsg()), { hasImage: false, parts: 0 });
  assert.deepEqual(imagesOf(imageMsg()), { hasImage: true, parts: 1 });
  assert.deepEqual(imagesOf([{ role: 'user', content: '这张图里有什么' }]), { hasImage: false, parts: 0 }, '纯文本提到"图"不算——按文本猜是改造前那条路，本模块不重复它');
  assert.deepEqual(imagesOf([{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }]), { hasImage: true, parts: 1 });
  assert.deepEqual(imagesOf([{ role: 'user', content: [{ type: 'image', source: {} }] }]), { hasImage: true, parts: 1 });
  assert.deepEqual(imagesOf(null), { hasImage: false, parts: 0 });
});

// ---------------------------------------------------------------------------
// 二、视觉维：**显式否定** ⇒ 发图前拒绝（一个请求都没出去）；标签支持 / 缺标签 ⇒ 照发
// ---------------------------------------------------------------------------
test('视觉维（显式否定）：发图前就拒绝，且**没有任何请求被发出去**', async (t) => {
  const spy = t.mock.method(globalThis, 'fetch', async () => { throw new Error('不该被调用：视觉闸门必须在发送前拦下'); });
  await assert.rejects(() => chatOnceWithTools(P_VISION_NEG.id, 'fixture-model-1', imageMsg(), [toolDef('read_file')], KEYS),
    /不支持图像输入|没有 vision/, '必须明确报错（说明模型**显式声明**不支持图像输入）');
  assert.equal(spy.mock.callCount(), 0, '发图前拒绝 ⇒ fetch 一次都不该被调用（不能等模型侧失败）');
  // 纯文本照样能走（闸门只拦"带图"的消息）
  t.mock.method(globalThis, 'fetch', async () => fakeOnce());
  const ok = await chatOnceWithTools(P_VISION_NEG.id, 'fixture-model-1', textMsg(), [], KEYS);
  assert.equal(ok.content, 'ok');
  // 报错文案要说清"是谁、几条图 part、是显式声明"，且给出可行出路
  const msg = visionRefusalMessage(capabilitiesOf(P_VISION_NEG, 'fixture-model-1'), 1);
  assert.match(msg, /fixture-vision-neg/);
  assert.match(msg, /1 个图像 part/);
  assert.match(msg, /ocr_image|view_image/);
  assert.match(msg, /显式声明不支持图像输入/, '文案必须点名"显式声明"——缺标签不该走到这条错里');
});

test('视觉维（标签支持 / 缺标签）：照发 —— 缺标签不得被当成"不支持"（返工夹具）', async (t) => {
  const spy = t.mock.method(globalThis, 'fetch', async () => fakeOnce());
  await chatOnceWithTools(P_VISION_YES.id, 'fixture-model-1', imageMsg(), [], KEYS);
  assert.equal(spy.mock.callCount(), 1, '标签有 vision ⇒ 图照发');
  // 缺 'vision' 标签（与真 deepseek 同形：['chat','code','reasoning']）⇒ **同样照发**
  const spyNotag = t.mock.method(globalThis, 'fetch', async () => fakeOnce());
  await chatOnceWithTools(P_VISION_NOTAG.id, 'fixture-model-1', imageMsg(), [], KEYS);
  assert.equal(spyNotag.mock.callCount(), 1, '缺 vision 标签 ≠ 不支持：不得因此拒绝发图（返工要求）');
  // 真 deepseek 也照发：它的 vision 是 null（未声明），不是 false
  const spyReal = t.mock.method(globalThis, 'fetch', async () => fakeOnce());
  await chatOnce('deepseek', imageMsg(), { model: 'deepseek-v4-flash' }, { deepseek: 'k' });
  assert.equal(spyReal.mock.callCount(), 1, '真清单里 deepseek 无 vision 标签 ⇒ 未声明 ⇒ 照发（行为与改造前一致）');
  // 未声明（整条没写 capabilities）⇒ 也照发
  const spyNC = t.mock.method(globalThis, 'fetch', async () => fakeOnce());
  await chatOnceWithTools(P_NOCAPS.id, 'fixture-model-1', imageMsg(), [], KEYS);
  assert.equal(spyNC.mock.callCount(), 1, '缺声明 ≠ 不支持：不得因此拒绝发图');
  // 真实厂商那半边：ark 标签有 vision ⇒ 照发
  const spyArk = t.mock.method(globalThis, 'fetch', async () => fakeOnce());
  await chatOnce('ark', imageMsg(), { model: 'doubao-seed-2-1-pro-260628' }, { ark: 'k' });
  assert.equal(spyArk.mock.callCount(), 1, '真实清单里 ark 标签有 vision ⇒ 照发');
});

// ---------------------------------------------------------------------------
// 三、工具维：**显式否定** ⇒ 工具面根本不发出去并如实记账；标签支持 / 缺标签 ⇒ 现状（这条是返工核心）
// ---------------------------------------------------------------------------
test('工具维（显式否定）：tools 字段不发出去（空数组），并如实记一条被收窄', async (t) => {
  let body = null;
  t.mock.method(globalThis, 'fetch', async (url, init) => { body = JSON.parse(init.body); return fakeOnce(); });
  const opts = {};
  await chatOnceWithTools(P_TOOL_NEG.id, 'fixture-model-1', textMsg(), [toolDef('read_file'), toolDef('run_command')], KEYS, 0.4, opts);
  assert.deepEqual(body.tools, [], '显式否定工具 ⇒ 工具面一个都不发（不是"发了让厂商报错"）');
  assert.equal(body.model, 'fixture-model-1', '模型名照常');
  assert.equal(opts.capNote.kind, 'tool-face-pruned', '必须留下"因显式否定而收窄"的事实（后续据此如实上报）');
  assert.equal(opts.capNote.provider, P_TOOL_NEG.id);
});

test('工具维（缺标签 / 标签支持）：工具面照发 —— **缺 tool 标签绝不许收窄工具面**（返工的核心夹具）', async (t) => {
  let body = null;
  t.mock.method(globalThis, 'fetch', async (url, init) => { body = JSON.parse(init.body); return fakeOnce(); });
  // ① 返工要求的那条：`capabilities: ['chat','code','reasoning']`（缺 'tool'）⇒ canDo 不是 false、工具面照发
  assert.notEqual(canDo(capabilitiesOf(P_TOOL_NOTAG), 'tool'), false, '缺 tool 标签不得判成 false');
  const optsNotag = {};
  await chatOnceWithTools(P_TOOL_NOTAG.id, 'fixture-model-1', textMsg(), [toolDef('read_file'), toolDef('run_command')], KEYS, 0.4, optsNotag);
  assert.equal(body.tools.length, 2, '缺 tool 标签 ⇒ 工具面**照发**（一个都不许少）');
  assert.equal(optsNotag.capNote, undefined, '没被收窄就不该记"被收窄"');
  // ② 标签支持 ⇒ 照发
  const optsYes = {};
  await chatOnceWithTools(P_TOOL_YES.id, 'fixture-model-1', textMsg(), [toolDef('read_file')], KEYS, 0.4, optsYes);
  assert.equal(body.tools.length, 1);
  assert.equal(optsYes.capNote, undefined, '标签支持 ⇒ 不收窄、不记账');
  // ③ 整条没写 capabilities ⇒ 照发
  const optsNone = {};
  await chatOnceWithTools(P_NOCAPS.id, 'fixture-model-1', textMsg(), [toolDef('read_file')], KEYS, 0.4, optsNone);
  assert.equal(body.tools.length, 1, '缺声明 ⇒ 工具面照发（不得因没配就收窄）');
  assert.equal(optsNone.capNote, undefined);
  // ④ **线上的主力 provider**：deepseek 标签无 'tool'，但它一直在调工具 ⇒ 工具面必须原样发出（返工要防的正是这条）
  const optsReal = {};
  await chatOnceWithTools('deepseek', 'deepseek-v4-flash', textMsg(), [toolDef('read_file'), toolDef('db_query')], { deepseek: 'k' }, 0.4, optsReal);
  assert.equal(body.tools.length, 2, 'DeepSeek 必须照常拿到工具面（C1–C5 计量与自检都跑在它上面）');
  assert.equal(optsReal.capNote, undefined, 'DeepSeek 不得被判成"不支持工具"');
  // ⑤ 反向：如果哪天有人在专用字段里给 deepseek 写了 tool:false，那才是真否定（这条证明闸门没坏，只是触发条件收紧了）
  const P_TOOL_NEG2 = providerLike('fixture-tool-neg2', ['chat', 'code', 'reasoning'], { ...base('fixture-tool-neg2'), [CAP_OVERRIDE_FIELD]: { tool: false } });
  PROVIDERS.push(P_TOOL_NEG2);
  try {
    const optsNeg = {};
    await chatOnceWithTools(P_TOOL_NEG2.id, 'fixture-model-1', textMsg(), [toolDef('read_file')], KEYS, 0.4, optsNeg);
    assert.equal(optsNeg.capNote.kind, 'tool-face-pruned', '同一份标签 + 显式否定 ⇒ 才收窄（触发条件＝专用字段）');
  } finally { PROVIDERS.splice(PROVIDERS.indexOf(P_TOOL_NEG2), 1); }
});

// ---------------------------------------------------------------------------
// 四、思考维：**显式否定** ⇒ 思考增量不转发（但不静默丢）；标签支持 / 缺标签 ⇒ 照转
// ---------------------------------------------------------------------------
test('思考维（显式否定）：思考增量不转发，且**不静默丢**（返回值带丢弃字符数）', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeStream('我很努力地在想'));
  const spy = thinkSpy();
  const res = await chatStreamWithTools(P_REASON_NEG.id, 'fixture-model-1', textMsg(), [], KEYS, { onThink: spy.fn });
  assert.deepEqual(spy.seen, [], '显式否定 reasoning ⇒ 不该让它显示成"它在思考"');
  assert.equal(res.reasoningDeclared, false);
  assert.equal(res.reasoningPruned, '我很努力地在想'.length, '丢弃必须计数并带出去（静默丢就是另一种说谎）');
  assert.equal(res.content, 'hi', '正文不受影响');
});

test('思考维（标签支持 / 缺标签）：思考增量照转 —— 缺标签不得被当成"不支持"', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeStream('先看文件'));
  const spyYes = thinkSpy();
  const rYes = await chatStreamWithTools(P_REASON_YES.id, 'fixture-model-1', textMsg(), [], KEYS, { onThink: spyYes.fn });
  assert.deepEqual(spyYes.seen, ['先看文件'], '标签支持 ⇒ 照转');
  assert.equal(rYes.reasoningPruned, 0);
  // 缺 'reasoning' 标签（与 glm 那些 thinking 模型同形）⇒ **照转**：不得因为标签里没写就不透出思考
  t.mock.method(globalThis, 'fetch', async () => fakeStream('先看文件'));
  const spyNotag = thinkSpy();
  const rNotag = await chatStreamWithTools(P_REASON_NOTAG.id, 'fixture-model-1', textMsg(), [], KEYS, { onThink: spyNotag.fn });
  assert.deepEqual(spyNotag.seen, ['先看文件'], '缺 reasoning 标签 ⇒ 思考照转（返工要求）');
  assert.equal(rNotag.reasoningDeclared, null, '未声明要如实报 null，不是 false');
  assert.equal(rNotag.reasoningPruned, 0);
  // 整条没写 capabilities ⇒ 照转
  t.mock.method(globalThis, 'fetch', async () => fakeStream('先看文件'));
  const spyNC = thinkSpy();
  const rNC = await chatStreamWithTools(P_NOCAPS.id, 'fixture-model-1', textMsg(), [], KEYS, { onThink: spyNC.fn });
  assert.deepEqual(spyNC.seen, ['先看文件'], '缺声明 ⇒ 思考照转（不得因没配就不显示）');
  assert.equal(rNC.reasoningDeclared, null);
  // 真实厂商：deepseek 标签有 reasoning ⇒ 照转（真清单那半边）
  t.mock.method(globalThis, 'fetch', async () => fakeStream('想想'));
  const spyReal = thinkSpy();
  const rReal = await chatStreamWithTools('deepseek', 'deepseek-v4-flash', textMsg(), [], { deepseek: 'k' }, { onThink: spyReal.fn });
  assert.deepEqual(spyReal.seen, ['想想']);
  assert.equal(rReal.reasoningDeclared, true);
});

// ---------------------------------------------------------------------------
// 五、清单如实上报：三维各自的取值 + 一句实话（"显式不支持"与"未声明"必须能分辨）
// ---------------------------------------------------------------------------
test('清单如实上报三维：绑定模型时报声明取值；未绑定时报"未绑定"且不猜默认模型', () => {
  const bound = capabilityManifest({ permission: 'read', preset: 'all', mode: 'chat', provider: 'ark', model: 'doubao-seed-2-1-pro-260628' }, { tools: ['read_file'] });
  assert.equal(bound.model.bound, true);
  assert.equal(bound.model.provider, 'ark');
  assert.equal(bound.model.model, 'doubao-seed-2-1-pro-260628');
  const rows = Object.fromEntries(bound.model.capabilities.map((r) => [r.dimension, r]));
  assert.deepEqual(Object.keys(rows).sort(), ['reasoning', 'tool', 'vision'], '三维一条都不能少');
  assert.equal(rows.vision.supports, true, 'ark 标签里有 vision ⇒ true');
  assert.equal(rows.tool.supports, null, 'ark 标签里没有 tool ⇒ **未声明（null）**，不是"不支持"');
  assert.equal(rows.reasoning.supports, null);
  assert.match(rows.vision.note, /声明支持/);
  assert.match(rows.tool.note, /未声明/, '缺标签必须报"未声明"——报"不支持"就是发明声明（本次返工的根因）');
  assert.match(rows.tool.note, /不算/, '话里要说清"标签里没有不算不支持"');
  assert.deepEqual(bound.model.explicitNegations, [], '今天没有任何厂商用专用字段声明否定');
  assert.ok(bound.model.declarationSource.includes('capabilitiesDeclared'), '显式否定字段的出处要写出来');
  assert.equal(typeof bound.model.consumers.vision, 'string', '每一维的消费点要能被读到');

  // 显式否定那半边（夹具）：三态里的 false 只在专用字段写 false 时出现，且出处必须是那个字段
  const negManifest = capabilityManifest({ permission: 'read', provider: P_TOOL_NEG.id, model: 'fixture-model-1' });
  const negRows = Object.fromEntries(negManifest.model.capabilities.map((r) => [r.dimension, r]));
  assert.equal(negRows.tool.supports, false);
  assert.match(negRows.tool.note, /显式声明不支持/);
  assert.equal(negRows.tool.declaredIn, CAP_OVERRIDE_FIELD, 'false 的出处必须是专用字段（标签永远不产生 false）');
  assert.deepEqual(negManifest.model.explicitNegations, ['tool']);

  // 未声明：三维都是 null，且话术是"未声明/按改造前行为"，不是"不支持"
  const noCaps = capabilityManifest({ permission: 'read', provider: P_NOCAPS.id, model: 'fixture-model-1' });
  const nc = Object.fromEntries(noCaps.model.capabilities.map((r) => [r.dimension, r]));
  assert.equal(nc.vision.supports, null, '未声明 ⇒ null（不是 false）');
  assert.match(nc.vision.note, /未声明/);
  assert.match(nc.vision.note, /改造前行为/, '未声明的处置必须写明"维持改造前行为"');
  assert.equal(nc.vision.declaredIn, null, '没声明就没有声明出处（不编一个）');

  // 未绑定模型：如实说"没绑定"，绝不猜一个默认模型写上去
  const unbound = capabilityManifest({ permission: 'read', preset: 'all' });
  assert.equal(unbound.model.bound, false);
  assert.equal(unbound.model.provider, null);
  assert.equal(unbound.model.model, null);
  assert.match(unbound.model.note, /未绑定/);
  assert.equal(unbound.model.capabilities.every((r) => r.supports === null), true, '没绑定就没有声明可报：三维都是 null');
});

test('工具面被收窄的事实在既有出口里读得到（run_end.capabilities.used，不新造事件类型）', () => {
  // 逐次上报走的是现成出口：agent 把这条事实记进 toolLog，index.js 早就把 toolLog 的名字列表当 used 传出去。
  const s = capabilitySummary({ permission: 'full', root: '/' }, ['read_file', USED_TOOL_FACE_PRUNED]);
  assert.deepEqual(s.used, ['read_file', USED_TOOL_FACE_PRUNED], '收窄事实必须出现在 run_end.capabilities.used 里');
  assert.match(USED_TOOL_FACE_PRUNED, /^cap:/, '带 cap: 前缀，一眼能看出它不是工具名');
  // 紧凑版仍然要小（原有 ≤300 字符的判据不许被这条新增撑破）
  assert.ok(JSON.stringify(s).length < 300, '紧凑版大小上界不变');
});
