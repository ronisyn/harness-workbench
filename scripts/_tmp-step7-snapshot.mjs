// 步7 前置：抓取改造前的工具面快照（作为"改造零漂移"的对照基准）
// 输出：JSON —— 每个工具的契约（name/description/params/permission）+ 元数据（tier/cn/when/not/ex）+ 四个集合
import fs from 'node:fs';
import { TOOLS, toolDefs } from 'file:///srv/harness-workbench/server/tools/index.js';
import { TOOL_META, DEFAULT_TOOLSET, PLATFORM_EXEMPT, TOOL_CN, TOOL_TIER_CN, LIGHT_TOOLSET } from 'file:///srv/harness-workbench/server/tools/meta.js';

const defs = toolDefs('all', null, null).filter((d) => !/^mcp_/.test(d.function.name)); // 只取本地工具（MCP 动态注册，不入快照）
const out = {
  defs: defs.map((d) => d.function).sort((a, b) => a.name.localeCompare(b.name)),
  tools: TOOLS.filter((t) => !/^mcp_/.test(t.name)).map((t) => ({ name: t.name, permission: t.permission, params: t.params })).sort((a, b) => a.name.localeCompare(b.name)),
  meta: Object.fromEntries(Object.entries(TOOL_META).sort(([a], [b]) => a.localeCompare(b))),
  cn: Object.fromEntries(Object.entries(TOOL_CN).sort(([a], [b]) => a.localeCompare(b))),
  tierCn: TOOL_TIER_CN,
  defaultToolset: [...DEFAULT_TOOLSET].sort(),
  platformExempt: [...PLATFORM_EXEMPT].sort(),
  lightToolset: [...LIGHT_TOOLSET].sort(),
};
const names = out.defs.map((d) => d.name);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
console.log('本地工具数=' + names.length + ' 重复=' + (dup.length ? dup.join(',') : '无'));
console.log('meta 键数=' + Object.keys(out.meta).length + '（与工具数之差=' + (Object.keys(out.meta).length - names.length) + '）');
const noMeta = names.filter((n) => !out.meta[n]);
const ghostMeta = Object.keys(out.meta).filter((n) => !names.includes(n));
console.log('缺 meta 的工具: ' + (noMeta.join(',') || '无'));
console.log('meta 里多出的键: ' + (ghostMeta.join(',') || '无'));
fs.writeFileSync('/tmp/tools-snapshot.json', JSON.stringify(out, null, 1));
console.log('已写 /tmp/tools-snapshot.json (' + fs.statSync('/tmp/tools-snapshot.json').size + ' 字节)');
process.exit(0);
