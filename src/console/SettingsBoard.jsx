// src/console/SettingsBoard.jsx - 1.8 设置（R2：复用共享 SettingsPanel，消除与对话页"高级参数"双实现）
import React from 'react';
import SettingsPanel from '../shared/SettingsPanel.jsx';

export default function SettingsBoard() {
  return (
    <div>
      <SettingsPanel />
      <div className="rw-console-note">MCP 在「对话页 ⚙ 设置 → MCP」；能力/工具/规则见 1.4 Agent 能力（与对话页同一共享组件）。</div>
    </div>
  );
}
