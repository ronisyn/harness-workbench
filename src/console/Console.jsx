// src/console/Console.jsx - 统一后台（分组导航：平台 / Agent / 应用市场；入口 /console/*，同站同账号）
// 2026-09-09 重分组（用户定）：平台（模型广场/观测/知识库/设置）；Agent（能力/进化）；
// 应用市场（Agent壳/应用/扩展中心）。板块 code 不变（URL 兼容），仅分组/标签调整。
// A5：技能库=平台板块（code 'skills'；能力页=工具集内容仍在 agent-caps 以保 URL 兼容）。
import React from 'react';
import ModelObsBoard from './ModelObs.jsx';
import KbBoard from './KbBoard.jsx';
import SettingsBoard from './SettingsBoard.jsx';
import ModelPlazaBoard from './ModelPlaza.jsx';
import AgentBoard from './AgentBoard.jsx';
import CapsBoard from './CapsBoard.jsx';
import EvoBoard from './EvoBoard.jsx';
import AppsBoard from './AppsBoard.jsx';
import ExtCenterBoard from './ExtCenterBoard.jsx';
import SkillsBoard from './SkillsBoard.jsx';
import TasksBoard from './TasksBoard.jsx';

// 板块注册表：code → { group, label, render }（group 决定左侧分组）
export const BOARDS = {
  // —— 平台 ——
  'models-plaza': { group: '平台', label: '模型广场', render: () => <ModelPlazaBoard /> },
  'models-obs': { group: '平台', label: '模型观测', render: () => <ModelObsBoard /> },
  'skills': { group: '平台', label: '技能库', render: () => <SkillsBoard /> },
  'kb': { group: '平台', label: '知识库', render: () => <KbBoard /> },
  // A4：工具集/规则（§8.5）归平台组；code agent-caps 保留兼容旧链
  'agent-caps': { group: '平台', label: '工具集', render: () => <CapsBoard /> },
  // —— Agent ——
  'agent-evo': { group: 'Agent', label: '进化集', render: () => <EvoBoard /> },
  // —— 应用市场 ——
  // A2：壳开发 1.3 升级为 Agent（壳）页 = 壳列表/详情/新建 + 装配向导 + 任务模板库子区（§8.9；URL code 不变兼容旧链）
  'agent-dev': { group: '应用市场', label: 'Agent（壳）', render: () => <AgentBoard /> },
  'agent-apps': { group: '应用市场', label: '应用', render: (p) => <AppsBoard {...p} /> },
  // A3：原"插件"占位 code 升级为 扩展中心（插件/MCP/应用统一资产页，§8.8；code 不变兼容 /console/plugins 旧链）
  'plugins': { group: '应用市场', label: '扩展中心', render: () => <ExtCenterBoard /> },
  // —— 系统（A8 起：任务独立板块；A9 将加审计） ——
  'tasks': { group: '系统', label: '任务', render: () => <TasksBoard /> },
  'settings': { group: '系统', label: '设置', render: () => <SettingsBoard /> },
};
const GROUPS = ['平台', 'Agent', '应用市场', '系统'];

export default function Console({ user, path, onGoHome, onGoChat, onLogout }) {
  const rawCode = path.replace(/^\/console\/?/, '') || '';
  const code = BOARDS[rawCode] ? rawCode : 'models-plaza'; // 未知板块回退 1.1，导航高亮跟随实际展示
  const board = BOARDS[code];
  // 板块可接收公共导航 props（AppsBoard 启动应用后跳对话页——审计 P1-3）
  const boardProps = { onGoChat };
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
