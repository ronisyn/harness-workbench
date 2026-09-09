// src/console/CapsBoard.jsx - 1.4 Agent 能力
// 2026-09-09 修正：移除未接线的 A/B/C 虚假"能力开关"（从未驱动运行时）；真实可配面=工具启用集（中文名/用途/分级勾选）+ 规则。
import React from 'react';
import ToolsetEditor from '../shared/ToolsetEditor.jsx';
import RulesEditor from '../shared/RulesEditor.jsx';

export default function CapsBoard() {
  return (
    <div className="rw-cap-group">
      <ToolsetEditor />
      <RulesEditor />
    </div>
  );
}
