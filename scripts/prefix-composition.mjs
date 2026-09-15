// scripts/prefix-composition.mjs - 只读：固定前缀 P（≈10,496 tokens）的构成拆解
//
// 为什么要有它：冷启动重建成本 ∝ P，每轮输入也 ∝ P —— 所以"前缀里到底装了什么、能砍多少"
// 是缓存方案里唯一一次性、无运行成本的杠杆（方案文档 M3）。
//
// 实测（2026-09-15）：系统提示三层 ≈1,221 tokens；工具面 all 档（65 个）≈7,210、standard（58）≈6,452、
//   minimal（25）≈2,598；每轮输入实测中位 19,666 tokens ⇒ 工具面占一半以上。
//   注：字符→token 是粗估（中文 ≈1.6 字符/token，英文 JSON ≈3.4），只用来比较相对大小。
//
// 用法：node scripts/prefix-composition.mjs
import { ENV_MAP, ENV_IDENTITY, ENV_ENV, ENV_DISCIPLINE } from '../server/agent.js';
import { toolDefs } from '../server/tools/index.js';

const ct = (s) => String(s).length;
const zh = (s) => (String(s).match(/[\u4e00-\u9fa5]/g) || []).length;
const est = (s) => Math.round(ct(s) / (zh(s) / Math.max(1, ct(s)) > 0.25 ? 1.6 : 3.4)); // 粗估，只用于相对比较

console.log('== 系统提示三层 ==');
for (const [n, s] of [['ENV_IDENTITY(full)', ENV_IDENTITY('full')], ['ENV_ENV', ENV_ENV], ['ENV_DISCIPLINE', ENV_DISCIPLINE], ['ENV_MAP 合计', ENV_MAP]]) {
  console.log(`  ${n.padEnd(20)} ${String(ct(s)).padStart(6)} 字符  中文 ${String(zh(s)).padStart(5)}  ⇒ ≈${String(est(s)).padStart(5)} tokens`);
}

console.log('\n== 工具面（档位：minimal / standard / all）==');
for (const tier of ['minimal', 'standard', 'all']) {
  try {
    const d = toolDefs(tier, null, null);
    const j = JSON.stringify(d);
    console.log(`  ${tier.padEnd(9)} 工具 ${String(d.length).padStart(3)} 个  schema ${String(ct(j)).padStart(6)} 字符  ⇒ ≈${String(Math.round(ct(j) / 3.4)).padStart(5)} tokens`);
  } catch (e) { console.log(`  ${tier} 失败：${e.message}`); }
}

console.log('\n== all 档里最大的 10 个工具（要瘦身优先看这里）==');
const all = toolDefs('all', null, null);
const sized = all.map((d) => ({ n: d.function.name, c: ct(JSON.stringify(d)) })).sort((a, b) => b.c - a.c);
for (const x of sized.slice(0, 10)) console.log(`  ${x.n.padEnd(22)} ${String(x.c).padStart(6)} 字符  ≈${Math.round(x.c / 3.4)} tokens`);
const total = sized.reduce((a, b) => a + b.c, 0);
console.log(`  → 最大的 10 个占全部 schema 的 ${((sized.slice(0, 10).reduce((a, b) => a + b.c, 0) / total) * 100).toFixed(1)}%（共 ${all.length} 个 / ${total} 字符）`);

console.log('\n== 对照：实测固定前缀 P ≈ 10,496 tokens、每轮输入中位 ≈ 19,666 tokens（scripts/c1-dsh-parity.mjs 同源数据）==');
process.exit(0);
