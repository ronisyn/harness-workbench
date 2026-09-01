// src/App.jsx - 根组件：登录态管理 + 主界面
import React, { useState, useEffect } from 'react';
import Login from './Login.jsx';
import Chat from './Chat.jsx';
import { api, getToken, clearToken } from './api.js';

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api.me().then((d) => setUser(d.user)).catch(() => clearToken()).finally(() => setReady(true));
  }, []);

  if (!ready) return <div className="rw-loading">Roni Workbench 加载中…</div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Chat user={user} onLogout={() => { clearToken(); setUser(null); }} />;
}
