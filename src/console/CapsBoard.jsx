// src/console/CapsBoard.jsx - 1.4 Agent 能力（R1：组合共享 CapSwitches + ToolsetEditor + RulesEditor，
// 统一后台 1.4 Agent 能力（共享 CapSwitches+ToolsetEditor+RulesEditor——原对话页⚙设置抽屉已退役）
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
