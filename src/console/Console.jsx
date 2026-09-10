// src/console/Console.jsx - 统一后台（导航=蓝图 §8.2 定版：4 组 11 板块，命名/顺序即定版表）
// 模型：模型广场 / 模型观测；平台：工具集 / 技能库 / 知识库 / 进化集；
// 应用：Agent / 扩展中心；系统：任务 / 审计 / 设置。
// 板块 code = 定版英文短码（toolset/evo/agent/ext…）；历史 code 仅作 URL 兼容别名（ALIAS），
// 进入即 replaceState 归一到定版链，导航只出现定版 11 项（不再保留旧板块"第二套入口"）。
import React, { useEffect } from 'react';
import ModelObsBoard from './ModelObs.jsx';
import KbBoard from './KbBoard.jsx';
import SettingsBoard from './SettingsBoard.jsx';
import ModelPlazaBoard from './ModelPlaza.jsx';
import AgentBoard from './AgentBoard.jsx';
import ToolsetBoard from './ToolsetBoard.jsx';
import EvoBoard from './EvoBoard.jsx';
import ExtCenterBoard from './ExtCenterBoard.jsx';
import SkillsBoard from './SkillsBoard.jsx';
import TasksBoard from './TasksBoard.jsx';
import AuditBoard from './AuditBoard.jsx';

// 板块注册表：code → { group, label, render }（group 决定左侧分组；顺序即定版导航顺序）
export const BOARDS = {
  // —— 模型 ——
  'models-plaza': { group: '模型', label: '模型广场', render: () => <ModelPlazaBoard /> },
  'models-obs': { group: '模型', label: '模型观测', render: () => <ModelObsBoard /> },
  // —— 平台 ——
  'toolset': { group: '平台', label: '工具集', render: () => <ToolsetBoard /> },
  'skills': { group: '平台', label: '技能库', render: () => <SkillsBoard /> },
  'kb': { group: '平台', label: '知识库', render: () => <KbBoard /> },
  'evo': { group: '平台', label: '进化集', render: () => <EvoBoard /> },
  // —— 应用 ——
  'agent': { group: '应用', label: 'Agent', render: (p) => <AgentBoard {...p} /> },
  'ext': { group: '应用', label: '扩展中心', render: (p) => <ExtCenterBoard {...p} /> },
  // —— 系统 ——
  'tasks': { group: '系统', label: '任务', render: () => <TasksBoard /> },
  'audit': { group: '系统', label: '审计', render: (p) => <AuditBoard {...p} /> },
  'settings': { group: '系统', label: '设置', render: () => <SettingsBoard /> },
};
export const GROUPS = ['模型', '平台', '应用', '系统'];
// 历史 code → 定版 code（仅 URL 兼容；不进导航）：agent-caps=旧"能力/工具集"、agent-evo=旧进化集、
// agent-dev=旧"Agent（壳）"、plugins=旧"插件"占位、agent-apps=旧"应用"板块（已并入扩展中心，§8.2/§8.8）。
export const ALIAS = { 'agent-caps': 'toolset', 'agent-evo': 'evo', 'agent-dev': 'agent', 'plugins': 'ext', 'agent-apps': 'ext' };

export default function Console({ user, path, onGoHome, onGoChat, onLogout }) {
  const m = path.match(/^\/console\/?([^?]*)(\?.*)?$/);
  const rawCode = (m && m[1]) || '';
  const search = (m && m[2]) || '';       // 保留 query（如 /console/audit?conv=N）
  const code = BOARDS[rawCode] ? rawCode : (ALIAS[rawCode] || 'models-plaza'); // 未知板块回退定版首项
  const board = BOARDS[code];
  // 旧链进来即归一为新链（地址栏/刷新/分享都指向定版 code）
  useEffect(() => {
    if (rawCode && rawCode !== code) history.replaceState(null, '', '/console/' + code + search);
  }, [rawCode, code, search]);
  // 板块可接收公共导航 props（应用启动后跳对话页）
  const boardProps = { onGoChat, code };
  return (
    <div className="rw-shell">
      <header className="rw-topbar">
        <div className="rw-logo" onClick={onGoHome} title="返回总览首页">Roni Workbench</div>
        <div className="rw-conv-title">统一后台 · {board.group} / {board.label}</div>
        <div className="rw-top-actions">
          <button className="rw-btn" onClick={onGoHome} title="总览首页">🏠 首页</button>
          <button className="rw-btn pri" onClick={onGoChat} title="对话页（同一会话体系）">💬 对话页</button>
          <span className="rw-user">{user.username}</span>
          <button className="rw-btn" onClick={onLogout} title="退出">↪</button>
        </div>
      </header>
      <div className="rw-console">
        <aside className="rw-console-nav">
          {GROUPS.map((g) => (
            <div key={g} className="rw-console-group">
              <div className="rw-console-group-title">{g}</div>
              {Object.entries(BOARDS).filter(([, b]) => b.group === g).map(([key, b]) => (
                <a key={key} className={'rw-console-navitem' + (code === key ? ' sel' : '')}
                  href={'/console/' + key}
                  onClick={(e) => { e.preventDefault(); history.pushState(null, '', '/console/' + key); window.dispatchEvent(new PopStateEvent('popstate')); }}>
                  {b.label}
                </a>
              ))}
            </div>
          ))}
        </aside>
        <main className="rw-console-main">{board.render(boardProps)}</main>
      </div>
    </div>
  );
}
