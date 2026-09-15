// 步7 一次性生成器：按"改造前快照"生成声明式清单 server/tools/manifest.js（生成后人工编辑头部说明；用完即删）
import fs from 'node:fs';

const snap = JSON.parse(fs.readFileSync('test/fixtures/tools-snapshot.json', 'utf8'));
const defaultSet = new Set(snap.defaultToolset);
const exemptSet = new Set(snap.platformExempt);
const lightSet = new Set(snap.lightToolset);
const tierOrder = { core: 0, pro: 1, expert: 2 };
const names = snap.tools.map((t) => t.name).sort();
const byTier = { core: [], pro: [], expert: [] };
for (const n of names) {
  const tier = (snap.meta[n] || {}).tier || 'pro';
  if (!byTier[tier]) throw new Error('未知档位: ' + tier + ' @ ' + n);
  byTier[tier].push(n);
}
const q = (s) => "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const lines = [];
lines.push('// server/tools/manifest.js - 工具能力清单（**唯一的声明式权威**）：改名/改档/改提示/上下线，只改这里');
lines.push('// 定位（架构 §4.1/§4.3 工具三层分离 + 声明式装载）：');
lines.push('//   · 契约面（name/description/params/permission）与实现**同处**在 tools/index.js 的处理器里——它们必须同步演进，拆开只会漂移；');
lines.push('//   · 本清单拥有**策略与生命周期**：档位(tier)/中文名/选择提示(when·not·ex)/默认启用(defaultOn)/平台豁免(exempt)/轻量集(light)/上下线(enabled)；');
lines.push('//   · 装载器 tools/registry.js 一次性装配并校验：清单与实现不一致**当场报错**，不再靠人记。');
lines.push('// 上下线一个工具（零代码改动）：');
lines.push('//   · 删掉这一行 → 工具从"模型可见面(toolDefs)"与"可执行面(execTool)"同时消失（默认拒绝）；');
lines.push('//   · 或写 enabled: false → 保留声明与理由，同样不装载（推荐：留痕式下线）。');
lines.push('// 字段缺省：tier 必填；when/not/ex 选填；defaultOn/exempt/light 缺省 false；enabled 缺省 true。');
lines.push('');
lines.push('export const TOOL_MANIFEST = {');
for (const tier of ['core', 'pro', 'expert']) {
  const list = byTier[tier].sort();
  lines.push('  // ===== ' + tier + '(' + list.length + ') =====');
  for (const n of list) {
    const m = snap.meta[n] || {};
    const parts = ['tier: ' + q(tier)];
    parts.push('cn: ' + q(snap.cn[n] || ''));
    if (m.when) parts.push('when: ' + q(m.when));
    if (m.not) parts.push('not: ' + q(m.not));
    if (m.ex) parts.push('ex: ' + q(m.ex));
    if (defaultSet.has(n)) parts.push('defaultOn: true');
    if (exemptSet.has(n)) parts.push('exempt: true');
    if (lightSet.has(n)) parts.push('light: true');
    lines.push('  ' + n + ': { ' + parts.join(', ') + ' },');
  }
}
lines.push('};');
lines.push('');
lines.push('// 档位中文名（后台展示用）');
lines.push("export const TOOL_TIER_CN = { core: '基础', pro: '专业', expert: '高危' };");
lines.push('');
fs.writeFileSync('server/tools/manifest.js', lines.join('\n'));
console.log('已生成 server/tools/manifest.js：' + names.length + ' 条（core ' + byTier.core.length + ' / pro ' + byTier.pro.length + ' / expert ' + byTier.expert.length + '）');
console.log('flags: defaultOn=' + defaultSet.size + ' exempt=' + exemptSet.size + ' light=' + lightSet.size);
