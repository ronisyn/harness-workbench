// src/console/SettingsBoard.jsx - 1.8 设置（系统组）：高级参数（SettingsPanel）+ MCP 管理 + 定时任务管理
// 终审去冗余：对话页⚙设置抽屉退役后，原抽屉"MCP/定时任务"区迁入本板块（数据链路不变：settings.mcp_servers + /api/mcp /api/tasks）
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import SettingsPanel from '../shared/SettingsPanel.jsx';

/* —— MCP 管理（原对话页⚙设置→MCP；P11 外部工具接入）—— */
function McpManager() {
  const [text, setText] = useState('[]');
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setText(JSON.stringify((s.settings?.mcp_servers || []), null, 2));
      const m = await api.mcpStatus();
      setStatus('已配置 ' + (m.configured || []).length + ' 个 server；已连接 ' + (m.clients || []).length + ' 个：' + (m.clients || []).map((c) => c.id).join(', '));
    } catch (e) { setErr('MCP 查询失败：' + (e.message || e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const save = async () => {
    let parsed = [];
    try { parsed = JSON.parse(text || '[]'); if (!Array.isArray(parsed)) throw new Error('需为数组'); }
    catch (e) { setErr('MCP 配置格式错误：' + e.message); return; }
    setErr('');
    try {
      await api.setSettings({ mcp_servers: parsed });
      const r = await api.mcpReload();
      setStatus('已保存并重连：' + (r.results || []).map((x) => (x.ok ? '✅' : '❌') + x.id).join(' ') + '；注册工具 ' + (r.registeredTools || 0) + ' 个');
    } catch (e) { setErr('保存失败：' + e.message); }
  };
  return (
    <div className="rw-cap-group" style={{ marginTop: 18 }}>
      <div className="rw-cap-gtitle">MCP 外部工具接入（P11）——连接 MCP server 后，其工具以 mcp_serverId_tool 名提供给模型</div>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>{`配置格式（数组）：[ { id, command, args: [], env: { KEY: 值 } } ]。示例（GitHub MCP server）：
[ { "id": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "你的token" } } ]`}</div>
      <textarea className="rw-input" rows="10" style={{ fontFamily: 'monospace', fontSize: 12, width: '100%', boxSizing: 'border-box' }}
        value={text} onChange={(e) => setText(e.target.value)} placeholder='[]' />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button className="rw-btn" onClick={save}>保存并连接</button>
        {err && <span className="rw-kb-err" style={{ margin: 0 }}>{err}</span>}
      </div>
      {status && <div style={{ marginTop: 8, fontSize: 12 }}>{status}</div>}
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>提示：密钥字段（键名含 token/key/secret/password 等）在页面显示为 <code>__REDACTED__</code> 占位，不会明文下发——直接保存（不改动该键）即保留服务器原值；需更换时才填入新 token。token 仅存于服务器 settings（不写入前端存储）；server 需服务器上可执行（npx/docker 等）。</div>
    </div>
  );
}

/* —— 定时任务管理（原对话页⚙设置→定时任务；cron 分 时 日 月 周；进化载体 #3/#4 亦在此管理）—— */
function TasksManager() {
  const [tasks, setTasks] = useState([]);
  const [newTask, setNewTask] = useState({ name: '', cron: '30 2 * * *', prompt: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { const t = await api.tasks(); setTasks(t.tasks || []); }
    catch (e) { setErr('定时任务加载失败：' + (e.message || e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const ok = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2200); };
  const create = async () => {
    setErr('');
    if (!newTask.name.trim() || !newTask.prompt.trim()) { setErr('名称与指令必填'); return; }
    try {
      await api.createTask(newTask);
      setNewTask({ name: '', cron: '30 2 * * *', prompt: '' });
      ok('定时任务已创建'); load();
    } catch (e) { setErr(e.message); }
  };
  const toggle = async (id, enabled) => { try { await api.patchTask(id, { enabled }); ok(enabled ? '已启用' : '已暂停'); load(); } catch (e) { setErr(e.message); } };
  const del = async (id) => { if (!confirm('删除该定时任务？')) return; try { await api.deleteTask(id); ok('已删除'); load(); } catch (e) { setErr(e.message); } };
  return (
    <div className="rw-cap-group" style={{ marginTop: 18 }}>
      <div className="rw-cap-gtitle">定时任务（cron：分 时 日 月 周）——进化载体（每日自我进化 #4 / 周报 #3）与自定义任务</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-task-new">
        <input className="rw-input" placeholder="任务名称" value={newTask.name} onChange={(e) => setNewTask({ ...newTask, name: e.target.value })} />
        <input className="rw-input" placeholder="cron（如 30 2 * * * 每日2:30）" value={newTask.cron} onChange={(e) => setNewTask({ ...newTask, cron: e.target.value })} />
        <textarea className="rw-input" rows="2" placeholder="要 AI 执行的指令…" value={newTask.prompt} onChange={(e) => setNewTask({ ...newTask, prompt: e.target.value })} />
        <button className="rw-btn pri" onClick={create} disabled={!newTask.name || !newTask.prompt}>＋ 创建</button>
      </div>
      {tasks.map((t) => (
        <div key={t.id} className="rw-task-item">
          <div className="rw-task-head">
            <b>{t.name}</b>
            <span className={'rw-task-cron ' + (t.enabled ? 'on' : '')}>{t.enabled ? '● 运行中' : '○ 已暂停'}</span>
          </div>
          <div className="rw-task-meta">{t.cron} ｜ {t.provider}/{t.model}</div>
          <div className="rw-task-prompt">{String(t.prompt).slice(0, 100)}</div>
          {t.last_run && <div className="rw-task-last">上次：{String(t.last_run).slice(0, 16)}｜{String(t.last_result || '').slice(0, 60)}</div>}
          <div className="rw-task-ops">
            <button className="rw-btn" onClick={() => toggle(t.id, !t.enabled)}>{t.enabled ? '暂停' : '启用'}</button>
            <button className="rw-btn" onClick={() => del(t.id)}>删除</button>
          </div>
        </div>
      ))}
      {!tasks.length && <div className="rw-empty">暂无定时任务</div>}
    </div>
  );
}

export default function SettingsBoard() {
  return (
    <div className="rw-cap-group">
      <SettingsPanel />
      <McpManager />
      <TasksManager />
    </div>
  );
}
