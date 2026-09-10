// src/console/ToolsetBoard.jsx - 平台·工具集页（§8.5；原 CapsBoard/旧 code 'agent-caps' 已按 §8.2 定版更名并归一）
// 组成：访问规则（默认折叠）→ 工具启用集 v2（Tab/计数/搜索/防抖回滚）→ 工具使用率看板。
import React from 'react';
import ToolsetEditor from '../shared/ToolsetEditor.jsx';
import RulesEditor from '../shared/RulesEditor.jsx';
import ToolUsageBoard from './ToolUsageBoard.jsx';

export default function ToolsetBoard() {
  return (
    <div className="rw-cap-group">
      <details className="rw-provider" style={{ marginBottom: 12 }} open={false}>
        <summary className="rw-dash-title" style={{ cursor: 'pointer', display: 'inline-block' }}>访问规则 allow/deny（平台硬门禁：deny 无条件拦截 / allow 短路免审批；deny 优先）▾</summary>
        <div style={{ marginTop: 8 }}><RulesEditor /></div>
      </details>
      <ToolsetEditor />
      <ToolUsageBoard />
    </div>
  );
}
