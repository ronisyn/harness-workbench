// src/console/Console.jsx - 统一后台（分组导航：平台 / Agent / 应用市场；入口 /console/*，同站同账号）
// 2026-09-09 重分组（用户定）：平台（模型广场/观测/知识库/设置）；Agent（能力/进化）；
// 应用市场（壳开发/应用，插件体系建设中占位）。板块 code 不变（URL 兼容），仅分组/标签调整。
import React from 'react';
import ModelObsBoard from './ModelObs.jsx';
import KbBoard from './KbBoard.jsx';
import SettingsBoard from './SettingsBoard.jsx';
import ModelPlazaBoard from './ModelPlaza.jsx';
import AgentBoard from './AgentBoard.jsx';
import CapsBoard from './CapsBoard.jsx';
import EvoBoard from './EvoBoard.jsx';
import AppsBoard from './AppsBoard.jsx';

// 板块注册表：code → { group, label, render }（group 决定左侧分组）
export const BOARDS = {
  // —— 平台 ——
  'models-plaza': { group: '平台', label: '模型广场', render: () => <ModelPlazaBoard /> },
  'models-obs': { group: '平台', label: '模型观测', render: () => <ModelObsBoard /> },
  'kb': { group: '平台', label: '知识库', render: () => <KbBoard /> },
  'settings': { group: '平台', label: '设置', render: () => <SettingsBoard /> },
  // —— Agent ——
  'agent-caps': { group: 'Agent', label: 'Agent 能力', render: () => <CapsBoard /> },
  'agent-evo': { group: 'Agent', label: 'Agent 进化', render: () => <EvoBoard /> },
  // —— 应用市场 ——
  // A2：壳开发 1.3 升级为 Agent（壳）页 = 壳列表/详情/新建 + 装配向导 + 任务模板库子区（§8.9；URL code 不变兼容旧链）
  'agent-dev': { group: '应用市场', label: 'Agent（壳）', render: () => <AgentBoard /> },
  'agent-apps': { group: '应用市场', label: '应用', render: (p) => <AppsBoard {...p} /> },
  'plugins': { group: '应用市场', label: '插件', render: () => <div className="rw-console-ph"><b>插件体系（建设中）</b><div>按壳装卸的独立能力包：在通用环境研发验证 → 壳勾选装配 → 删除即整体卸载（A 壳不要就不勾，B 壳要就勾）。Excel/PDF/图片/视频等插件将在此上架；当前为占位，详见讨论方案。A3 扩展中心落地后并入统一资产体系。</div></div> },
};
const GROUPS = ['平台', 'Agent', '应用市场'];

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
