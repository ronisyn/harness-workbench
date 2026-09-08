// src/console/Console.jsx - M2 统一后台（§7.1/§7.2 四组八项；入口 /console/*，同站同账号）
// 布局：顶栏（首页/对话/后台互跳）+ 左侧分组导航 + 内容区；板块注册表集中于此，随 M2 组次逐个落地。
import React from 'react';
import ModelObsBoard from './ModelObs.jsx';
import KbBoard from './KbBoard.jsx';
import SettingsBoard from './SettingsBoard.jsx';
import ModelPlazaBoard from './ModelPlaza.jsx';
import ShellDevBoard from './ShellDev.jsx';
import CapsBoard from './CapsBoard.jsx';
import EvoBoard from './EvoBoard.jsx';
import AppsBoard from './AppsBoard.jsx';

// 板块注册表：code → { group, label, render }
export const BOARDS = {
  'models-plaza': { group: '模型', label: '1.1 模型广场', render: () => <ModelPlazaBoard /> },
  'models-obs': { group: '模型', label: '1.2 模型观测', render: () => <ModelObsBoard /> },
  'agent-dev': { group: 'Agent', label: '1.3 Agent 开发（壳）', render: () => <ShellDevBoard /> },
  'agent-caps': { group: 'Agent', label: '1.4 Agent 能力', render: () => <CapsBoard /> },
  'agent-evo': { group: 'Agent', label: '1.5 Agent 进化', render: () => <EvoBoard /> },
  'agent-apps': { group: 'Agent', label: '1.6 Agent 广场（应用）', render: (p) => <AppsBoard {...p} /> },
  'kb': { group: '知识库', label: '1.7 知识库', render: () => <KbBoard /> },
  'settings': { group: '系统', label: '1.8 设置', render: () => <SettingsBoard /> },
};
const GROUPS = ['模型', 'Agent', '知识库', '系统'];

function Placeholder({ text }) {
  return <div className="rw-console-ph"><b>板块建设中</b><div>{text}</div></div>;
}

export default function Console({ user, path, onGoHome, onGoChat, onLogout }) {
  const rawCode = path.replace(/^\/console\/?/, '') || '';
  const code = BOARDS[rawCode] ? rawCode : 'models-plaza'; // P3-10：未知板块回退 1.1，导航高亮跟随实际展示
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
                  {b.label.replace(/^\d\.\d\s*/, '')}
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
