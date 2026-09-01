// src/Login.jsx - 登录页（太阳大地色）
import React, { useState } from 'react';
import { api, setToken } from './api.js';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('Ronisyn');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const d = await api.login(username, password);
      setToken(d.token);
      onLogin(d.user);
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="rw-login">
      <div className="rw-login-card">
        <h1 className="rw-login-logo">Roni Workbench</h1>
        <p className="rw-login-sub">自托管 AI 智能体平台</p>
        <form onSubmit={submit}>
          <input className="rw-input" placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          <input className="rw-input" type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
          {err && <div className="rw-err">{err}</div>}
          <button className="rw-btn pri rw-login-btn" disabled={busy}>{busy ? '登录中…' : '登 录'}</button>
        </form>
      </div>
    </div>
  );
}
