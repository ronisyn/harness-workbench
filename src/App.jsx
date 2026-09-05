// src/App.jsx - 根组件：登录态管理 + 主界面
import React, { useState, useEffect } from 'react';
import Login from './Login.jsx';
import Chat from './Chat.jsx';
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

  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api.me().then((d) => setUser(d.user)).catch(() => clearToken()).finally(() => setReady(true));
  }, []);

  if (!ready) return <div className="rw-loading">Roni Workbench 加载中…</div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Boundary><Chat user={user} onLogout={() => { clearToken(); setUser(null); }} /></Boundary>;
}
