// test/epoch-cost.test.mjs - 换纪元的代价必须在**决策点**可见（2026-09-16，C-31 实测驱动）
//
// 为什么要有这条：实测 214 次"整段重建"集中在一条 432 轮的会话上（量级 ≈14M tokens），成因是**在它活跃期间反复部署**
// ——改工具面/系统提示会换纪元，所有活跃会话的前缀整段作废。这不是代码 bug，是"代价没在决策点说出来"。
// 判据**不发明阈值**：`agent_runs.status='running'` 就是"活跃"的权威定义（不设时间窗口）。
// 本夹具锁住两处提示位：模型触发的重启（reload_platform）与人工部署（release.mjs 预检）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('模型触发的重启：结果里必须带"换纪元会作废活跃前缀"的代价说明', () => {
  const s = read('server/tools/index.js');
  assert.match(s, /PREFIX_COST_NOTE/, 'reload_platform 必须把代价说成一句可复用的话');
  assert.match(s, /所有活跃会话.*前缀.*整段重建/, '代价说明要讲清"作废的是谁"');
  assert.match(s, /prefixCost: PREFIX_COST_NOTE/, '成功调度重启的返回里也要带（不只是被拦时）');
  // 既有护栏不许被这次改动动掉：仍然会数"其他"活跃任务并拒绝
  assert.match(s, /reload 防撞：另有/, 'F2 防撞逻辑必须还在');
});

test('人工部署：release.mjs 预检要按 status=running 列出活跃会话（不设时间窗口）', () => {
  const s = read('scripts/release.mjs');
  assert.match(s, /agent_runs WHERE status='running'/, '判据用 status=running（不自己发明"最近 N 分钟"这类窗口）');
  assert.match(s, /前缀会整段重建/, '要说清这次发布会让活跃会话付什么代价');
  assert.match(s, /建议：把同类工具面改动攒成一批再发/, '要给可执行的建议，而不是只报数');
  // 读不到库时不许阻断发布（提示是"提醒"不是"闸门"）
  assert.match(s, /跳过活跃会话检查/, '读不到库要如实说跳过，不能把发布卡住');
});
