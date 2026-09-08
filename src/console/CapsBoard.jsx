// src/console/CapsBoard.jsx - 1.4 Agent 能力（R1：组合共享 CapSwitches + ToolsetEditor + RulesEditor，
// 与对话页⚙设置→能力/工具/规则同一组件——消除双实现分叉）
import React from 'react';
import CapSwitches from '../shared/CapSwitches.jsx';
import ToolsetEditor from '../shared/ToolsetEditor.jsx';
import RulesEditor from '../shared/RulesEditor.jsx';

export default function CapsBoard() {
  return (
    <div className="rw-cap-group">
      <CapSwitches chips />
      <ToolsetEditor />
      <RulesEditor />
    </div>
  );
}
