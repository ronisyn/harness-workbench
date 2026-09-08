// src/App.jsx - 根组件：登录态管理 + M1 路由分发（总览首页 `/` 默认 / 对话页 `/chat` / 统一后台 `/console/*`；v2.13 §7）
// 不引入路由库：按 location.pathname 分发；对话页可带 ?conv= 直达会话；登录成功默认落首页。
import React, { useState, useEffect } from 'react';
import Login from './Login.jsx';
import Chat from './Chat.jsx';
import Dashboard from './Dashboard.jsx';
import Console from './console/Console.jsx';
import { api, getToken, clearToken } from './api.js';

// 错误边界：渲染崩溃兜底（不白屏；显示错误并刷新恢复）
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      const e = this.state.err;
      return (
        <div className="rw-fatal">
          <h3>⚠ 界面渲染出错</h3>
          <pre>{(e && (e.stack || e.message)) || String(e)}</pre>
          <button className="rw-btn pri" onClick={() => location.reload()}>刷新恢复</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  // M1/M2：路径状态（/chat=对话页；/console* =统一后台；其余含 / 与未知路径 → 总览首页）
  const [path, setPath] = useState(location.pathname);
  const go = (p) => { history.pushState(null, '', p); setPath(p); };
  const [convParam, setConvParam] = useState('');

  // 登录后默认落总览首页（D4）；已登录直接访问 /chat?conv= /console/* 直达
  const enterChat = (convId, draft) => {
    setConvParam(convId || '');
    if (convId && draft) { try { sessionStorage.setItem('rw_draft_' + convId, draft); } catch { /* ignore */ } }
    go(convId ? '/chat?conv=' + convId : '/chat');
  };
  const enterConsole = (board) => { go(board ? '/console/' + board : '/console'); };

  useEffect(() => {
    const onPop = () => { setPath(location.pathname); setConvParam(new URLSearchParams(location.search).get('conv') || ''); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api.me().then((d) => setUser(d.user)).catch(() => clearToken()).finally(() => setReady(true));
  }, []);

  if (!ready) return <div className="rw-loading">Roni Workbench 加载中…</div>;
  if (!user) return <Login onLogin={setUser} />;
  const onLogout = () => { clearToken(); setUser(null); };
  const home = () => go('/');
  let view = null;
  if (path === '/chat') view = <Chat key={convParam || 'chat'} user={user} initialConvId={convParam || null} onGoHome={home} onGoConsole={enterConsole} onLogout={onLogout} />;
  else if (path === '/console' || path.startsWith('/console/')) view = <Console user={user} path={path} onGoHome={home} onGoChat={enterChat} onLogout={onLogout} />;
  else view = <Dashboard user={user} onGoChat={enterChat} onGoConsole={enterConsole} onLogout={onLogout} />;
  return <Boundary>{view}</Boundary>;
}
