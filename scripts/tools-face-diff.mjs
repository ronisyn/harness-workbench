#!/usr/bin/env node
// scripts/tools-face-diff.mjs - 工具面快照的**反向核对**：白名单之外必须零漂移
//
// 为什么必须有它：`test/manifest.test.mjs` 是"逐字段一致"的正向比对，任何工具面改动都要改夹具；
// 而改夹具这件事本身没有门禁——顺手多改一条、或改了忘登记，正向夹具都会照绿。
// 本脚本把白名单写成**代码里的清单**（可枚举、可评审），并打印每一处漂移：
//   · 白名单内的 `description` = 本次有意改动（必须带理由）
//   · 白名单外的一切漂移、以及白名单内的 `parameters` 漂移 = 非预期 → 非零退出码
//
// 用法：
//   node scripts/tools-face-diff.mjs            # 反向核对（白名单外零漂移才算通过）
//   node scripts/tools-face-diff.mjs --update   # 按当前实现重写夹具的 defs（只该在登记完白名单后跑）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolDefs } from '../server/tools/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = path.join(ROOT, 'test/fixtures/tools-snapshot.json');

// 白名单：本次**有意**改 description 的工具（工具名 → 理由）。参数 schema 谁都不许悄悄改，故不在此表内。
// 2026-09-16 A1（方案《提示注入防线》§3 候选 A1 / 决策 D1+D2）：外部来源工具描述加"不可信数据"声明
// —— 代价如实记账：工具面字节变化 ⇒ 换纪元一次（所有会话下次请求整段重建公共前缀）。
const WHITELIST = {
  web_search: 'A1：外部来源工具描述加不可信声明',
  fetch_url: 'A1：外部来源工具描述加不可信声明',
  feishu_doc_read: 'A1：外部来源工具描述加不可信声明',
  feishu_sheet_read: 'A1：外部来源工具描述加不可信声明',
  feishu_bitable_read: 'A1：外部来源工具描述加不可信声明',
  // 2026-09-16 ⑥ 溢出规范收口（v0.3 §6.1：大结果一律"预览 + 定位符 + 省略量，可取回"）：
  // 四个解析器与代码地图此前只在返回值里做溢出，描述里没说"明细在溢出文件里、用 fetch_spill 按范围取回"
  // ⇒ 模型不知道能取回、会重复解析或改用别的工具。描述补的是这一句（不含行为改动，行为在 ⑦/⑤ 已落地）。
  extract_pdf: '⑥ 溢出规范收口（v0.3 §6.1）：描述补"明细落在溢出文件里 + fetch_spill 按范围取回"',
  extract_docx: '⑥ 溢出规范收口（v0.3 §6.1）：描述补"明细落在溢出文件里 + fetch_spill 按范围取回"',
  extract_xlsx: '⑥ 溢出规范收口（v0.3 §6.1）：描述补"结构摘要 + 逐表 offset/length + fetch_spill 按范围取数"',
  extract_pptx: '⑥ 溢出规范收口（v0.3 §6.1）：描述补"明细落在溢出文件里 + fetch_spill 按范围取回"',
  repo_map: '⑥ 溢出规范收口（v0.3 §6.1）：描述补"地图过大时只回摘要+预览+溢出路径，明细用 fetch_spill 取回"',
};

const J = (x) => JSON.parse(JSON.stringify(x));
const byName = (arr) => Object.fromEntries(arr.map((x) => [x.name, x]));
const localDefs = toolDefs('all', null, null).filter((d) => !/^mcp_/.test(d.function.name));
const live = byName(localDefs.map((d) => d.function));
const snapRaw = JSON.parse(fs.readFileSync(SNAP, 'utf8'));

if (process.argv.includes('--update')) {
  // 就地改快照里那几条，不整份重写：夹具条目顺序是当初导出时的（与运行期注册表顺序不同），
  // 整份重写会把 65 条全部重排 ⇒ 真实改动被淹没在无意义的 diff 里（夹具只按名字取值，顺序不影响语义）。
  const fresh = new Map(localDefs.map((d) => [d.function.name, d.function]));
  snapRaw.defs = snapRaw.defs.map((d) => (fresh.has(d.name) ? fresh.get(d.name) : d));
  fs.writeFileSync(SNAP, JSON.stringify(snapRaw, null, 2) + '\n');
  console.log('[update] 夹具 defs 已就地更新（' + snapRaw.defs.length + ' 条，顺序与格式不变）——白名单内的改动也应在同一刻记下理由');
  process.exit(0);
}

const snap = byName(snapRaw.defs);
const drifted = [];
const add = (name, kind, allowed) => drifted.push({ name, kind, allowed });
for (const n of Object.keys(live)) {
  if (!snap[n]) { add(n, '新增工具', false); continue; }
  if (live[n].description !== snap[n].description) add(n, 'description', Boolean(WHITELIST[n]));
  if (JSON.stringify(J(live[n].parameters)) !== JSON.stringify(snap[n].parameters)) add(n, 'parameters（谁都不许悄悄改）', false);
}
for (const n of Object.keys(snap)) if (!live[n]) add(n, '工具消失', false);

console.log('工具面快照反向核对：' + Object.keys(snap).length + ' 条快照 × ' + Object.keys(live).length + ' 条实现');
console.log('白名单（' + Object.keys(WHITELIST).length + ' 条，均带理由）：');
for (const [n, why] of Object.entries(WHITELIST)) console.log('  · ' + n.padEnd(20) + why);

const outside = drifted.filter((d) => !d.allowed);
console.log('\n漂移 ' + drifted.length + ' 处（白名单内 ' + (drifted.length - outside.length) + ' / 白名单外 ' + outside.length + '）');
for (const d of drifted) console.log('  ' + (d.allowed ? '[白名单] ' : '[✗ 意外] ') + d.name.padEnd(20) + d.kind);

if (outside.length) {
  console.error('\n[✗] 白名单之外的工具面漂移：' + outside.map((d) => d.name).join(', ')
    + '\n    要么撤销改动，要么把它登记进本脚本的 WHITELIST（写明理由）并与其它会话可见的换纪元**同批**发布。');
  process.exit(1);
}
console.log('\n[✓] 白名单之外零漂移：工具面只动了上面登记的 ' + Object.keys(WHITELIST).length + ' 项。');
