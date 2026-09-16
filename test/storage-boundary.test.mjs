// test/storage-boundary.test.mjs —— 存储接口的**边界机检**（"扩围决定"的机器可读那一半）
//
// 背景（第五十二轮，架构师代决）：v0.3 §4.1 要求"存储走接口"，G1 的出口是
// 「干净机器 + 一份配置 → 跑通一次对话」。清单里的实体（引擎必需 + 遥测 + 治理链）**已经全部迁完**；
// `server/index.js` 等文件里剩下的直连 SQL 属于**管理面/产品面**（进化目标、扩展与需求、任务契约、
// 供应商与模型注册、reviews、telemetry 视图、渠道适配器…）——它们不在 v0.3 §7.1 的清单里。
//
// **裁决：不扩围，但把边界钉死**。理由（长期/稳定/全局）：
//   · 扩围到"全仓所有表"是数百处语句、跨多个会话的量级，而 v0.3（唯一权威）没有要求；
//   · 这些面在干净机器（JSON 介质）上本来就不成立（模型市场、供应商注册没有远端就没有意义），
//     硬迁只会为不存在的使用方造接口 —— 正是 §0.6「不做的范围」要避免的；
//   · 真正会漂移的是"**没人看着**"：新文件悄悄直连、已迁完的链又长回去。所以这里把两件事机检起来：
//     ① 直连 SQL 的**文件集合**必须等于登记表（新增文件当场红，逼一次显式登记）；
//     ② **已经迁完**的两条链（`selfeval/collect.js` 遥测、`storage/` 之外的接口消费者）不许回退。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT, contractMethods } from '../server/storage/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((it) => {
  const rel = d + '/' + it.name;
  if (it.isDirectory()) return it.name === 'node_modules' ? [] : walk(rel);
  return /\.m?js$/.test(it.name) ? [rel] : [];
});
// 注释里提到 SQL 不算使用（剥掉块注释与行注释再找），与 `单一选择点` 那条机检同一手法
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\S\n])\/\/[^\n]*/gm, '$1');
const SQL_RE = /(db|dbc|pool|database|conn|connc)\.(query|run|one)\(|(SELECT|INSERT INTO|UPDATE|DELETE FROM)\s/i;

/**
 * **边界登记表**：仍然是直连 SQL 的文件（分类给出理由；新增文件必须先进这里）。
 * 组①引擎与账本存量 · 组②渠道适配器 · 组③管理面/产品面（清单外，本轮裁决不迁）· 组④迁移与驱动 ·
 * 组⑤SQL 片段构造器（给"还没迁的调用方"生成 WHERE，判据与 JS 复算同源）· 组⑥遥测周边。
 */
const REGISTERED = {
  '组①引擎与账本存量': [
    'server/agent.js', 'server/epoch.js', 'server/canary.js', 'server/cards.js', 'server/projection.js',
    'server/replay.js', 'server/runtrack.js', 'server/subagent.js', 'server/tools/index.js', 'server/lessonrecall.js',
    // eventlog.js 的账本本体已走接口（`events.append/read`）；剩下的是**契约投影**那一条 INSERT
    // （写契约事实的投影表）——它属于"契约域整体未迁"，代码里就地写明了理由
    'server/eventlog.js',
  ],
  '组②渠道适配器（渠道自己的会话/消息落库路径，随渠道批迁）': [
    'server/channels/run-turn.js', 'server/channels/wechat.js', 'server/channels/feishu-webhook.js',
  ],
  '组③管理面/产品面（**清单外**：进化目标/扩展与需求/任务契约/供应商与模型/reviews/telemetry 视图/会话导出）': [
    'server/index.js', 'server/driver.js', 'server/scheduler.js', 'server/session-export.js', 'server/shellstore.js',
    'server/credentials.js', 'server/connectors.js', 'server/auth.js', 'server/llm/providers.js', 'server/llm/market.js',
    'server/kbsearch/fts.js', 'server/tools/manifest.js',
  ],
  '组④迁移与驱动（介质自己的地基，本就不该走接口）': ['server/db.js', 'server/migrations.js'],
  '组⑤SQL 片段构造器（给还没迁的调用方生成 WHERE；判据与 cohort.js 的 JS 复算同源）': ['server/cohort.js'],
  '组⑥遥测周边（写提案/告警那两支，读链已迁完）': [
    'server/selfeval/write.js', 'server/selfeval/alerts.js', 'server/selfeval/knowledge-sink.js',
  ],
};
const REGISTERED_FILES = Object.values(REGISTERED).flat().sort();

test('边界：直连 SQL 的文件集合必须等于登记表（新增文件当场红，逼一次显式登记）', () => {
  const hits = walk('server').filter((f) => !f.startsWith('server/storage/'))
    .filter((f) => SQL_RE.test(strip(fs.readFileSync(path.join(ROOT, f), 'utf8')))).sort();
  const added = hits.filter((f) => !REGISTERED_FILES.includes(f));
  const gone = REGISTERED_FILES.filter((f) => !hits.includes(f));
  assert.deepEqual(added, [], '有**未登记**的文件在直连 SQL（要么迁移它，要么把理由登记进 test/storage-boundary.test.mjs）：' + added.join('、'));
  assert.deepEqual(gone, [], '登记表里有文件已经不再直连 SQL —— 把它从登记表移走（表要与事实一致）：' + gone.join('、'));
});

test('已迁完的链不许回退：遥测采集（collect.js）0 处直连 SQL', () => {
  const src = strip(fs.readFileSync(path.join(ROOT, 'server/selfeval/collect.js'), 'utf8'));
  assert.equal(SQL_RE.test(src), false, 'collect.js 的五档/账本/失败率/金标/水位读数都已走存储接口，不许再出现 SQL 或 `db.query`');
  assert.match(src, /viaInterface/, '唯一的读数出口是 viaInterface（报错形状与旧路径一致）');
  assert.doesNotMatch(src, /from '\.\.\/db\.js'/, 'collect.js 不该再 import db（读法已全部走接口）');
});

test('接口覆盖：清单里的实体都在契约里，且方法面非空（"迁完"不是嘴上说说）', () => {
  // G1 出口链（跑通一次对话 + 记得住 + 看得见 + 能治理）所需的实体
  const MUST = ['conversations', 'messages', 'toolCalls', 'settings', 'agentRuns', 'events', 'usage', 'audit',
    'accounts', 'sessions', 'knowledge', 'deliveries', 'shells', 'scheduledTasks'];
  for (const e of MUST) {
    assert.ok(CONTRACT.entities[e] && CONTRACT.entities[e].length, `契约缺少实体 ${e}`);
  }
  // 写口必须成对存在：能写不能读 / 能读不能写 都是半迁移
  for (const [e, verb] of [['usage', 'append'], ['audit', 'append'], ['knowledge', 'append'], ['events', 'append']]) {
    assert.ok(CONTRACT.entities[e].includes(verb), `${e} 缺写口 ${verb}`);
  }
  const methods = contractMethods();
  assert.ok(methods.length >= 80, '方法面数量骤降说明有人删了契约（现约 84）：' + methods.length);
});
