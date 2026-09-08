// src/App.jsx - 根组件：登录态管理 + M1 路由分发（总览首页 `/` 默认 / 对话页 `/chat`；v2.12 §7.3/D4）
// 不引入路由库：按 location.pathname 分发；对话页可带 ?conv= 直达会话；登录成功默认落首页。
import React, { useState, useEffect } from 'react';
import Login from './Login.jsx';
import Chat from './Chat.jsx';
import Dashboard from './Dashboard.jsx';
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
  // M1：路径状态（/chat=对话页；其余含 / 与未知路径 → 总览首页）
  const [path, setPath] = useState(location.pathname);
  const go = (p) => { history.pushState(null, '', p); setPath(p); };
  const [convParam, setConvParam] = useState('');

  // 登录后默认落总览首页（D4：登录先见总览首页）；已登录直接访问 /chat?conv= 支持直达会话
  const enterChat = (convId) => { setConvParam(convId || ''); go(convId ? '/chat?conv=' + convId : '/chat'); };

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
  const isChat = path === '/chat';
  return (
    <Boundary>
      {isChat
        ? <Chat key={convParam || 'chat'} user={user} initialConvId={convParam || null} onGoHome={() => go('/')} onLogout={onLogout} />
        : <Dashboard user={user} onGoChat={enterChat} onLogout={onLogout} />}
    </Boundary>
  );
}
