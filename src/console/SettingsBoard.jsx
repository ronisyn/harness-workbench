// src/console/SettingsBoard.jsx - 系统·设置页（§8.10；纯运行时参数，按真实性清单收窄）：任务→任务页、MCP→扩展中心
import React from 'react';
import SettingsPanel from '../shared/SettingsPanel.jsx';

export default function SettingsBoard() {
  return (
    <div className="rw-cap-group">
      <SettingsPanel />
      <div className="rw-console-note">
        本页只留"真接线、不重复"的平台运行参数；定时任务已移至「系统 → 任务」，MCP 外部服务移至「应用 → 扩展中心」，
        工具启用集/规则在「平台 → 工具集」，模型启停/默认模型在「模型 → 模型广场」——避免同一参数两处可改（§8.10 设置收窄）。
      </div>
    </div>
  );
}
