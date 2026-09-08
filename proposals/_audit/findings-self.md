# 审计汇总暂存：人工独立核查发现（2026-09-08）

> 与四路子代理报告（API契约 / DB schema / 前端UI / 业务语义）合并成最终清单。

## 数据一致性（P2）
- 会话删除级联清单漏 **contract_events**（task_contracts 的子表，按 contract_id 关联）：删会话→删 task_contracts 行后 contract_events 变孤儿。server/index.js:220。
- 历史 E2E 残留孤儿（早前用 SQL 直删会话、未走级联清理）：usage_stats 51 行、tool_calls 82 行、messages 6 行（orphan audit 实测）。非产品缺陷，属数据污染，建议清理。
- 残留 disabled 测试壳：tmpcode、b1dup（shells 表），无会话引用，可清理。

## 场景/业务未完整（P3 边界项，文档已注）
- 1.2 模型观测板块未展示 §6.4"一次通过率"（reviews/model_telemetry 需 join；附录 D 已注"随 M2 后续"）——记录为待办非缺陷。
- Dashboard 迷你对话双击发送可能并发创建会话（state busy 异步；无 ref 级防重）——轻微交互隐患。

## 联调冒烟（独立跑，14/14 通过）
- settings PUT 往返、非法值 400、capabilities/toolset 往返、models 启停翻转、proposals 读、app launch→messages 空→删除、四路由 200。

## 待子代理报告返回后合并
