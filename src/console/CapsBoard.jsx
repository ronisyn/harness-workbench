// src/console/CapsBoard.jsx - A4 §8.5 工具集页（Agent 能力→工具集升级）：访问规则放列表上方（默认折叠展开编辑）→ 工具启用集 v2（Tab/计数/搜索/防抖回滚）→ 工具使用率看板。
import React from 'react';
import ToolsetEditor from '../shared/ToolsetEditor.jsx';
import RulesEditor from '../shared/RulesEditor.jsx';
import ToolUsageBoard from './ToolUsageBoard.jsx';

export default function CapsBoard() {
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
