// src/console/EvoBoard.jsx - 1.5 Agent 进化（D8：进化/周报信号卡 + 提案（R1 共享 ProposalsManager）+ 审计流水）
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import ProposalsManager from '../shared/ProposalsManager.jsx';

export default function EvoBoard() {
  const [tasks, setTasks] = useState([]);
  const [audit, setAudit] = useState([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    const [t, a] = await Promise.all([
      api.tasks().then((d) => ({ tasks: d.tasks || [] })).catch((e) => { setErr('定时任务加载失败：' + (e.message || e)); return { tasks: [] }; }),
      api.audit(60).then((d) => ({ audit: d.audit || [] })).catch((e) => { setErr('审计加载失败：' + (e.message || e)); return { audit: [] }; }),
    ]);
    setTasks(t.tasks || []);
    setAudit(a.audit || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const daily = tasks.find((x) => x.id === 4);
  const weekly = tasks.find((x) => x.id === 3);

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">进化载体（定时任务：每日自我进化 #4 · 周报 KPI #3）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      <div className="rw-dash-grid" style={{ marginTop: 0 }}>
        {daily && (
          <div className="rw-dash-card">
            <div className="rw-dash-title">每日自我进化（#4 · 05:00）</div>
            <div className="rw-dash-row"><span className={'rw-kb-tag ' + (daily.enabled ? 'global' : 'conv')}>{daily.enabled ? '运行中' : '已暂停'}</span>
              <span className="rw-dash-muted">上次 {daily.last_run ? String(daily.last_run).slice(0, 16) : '未运行'}</span></div>
            {daily.last_result && <div className="rw-dash-result">{String(daily.last_result).slice(0, 200)}</div>}
          </div>
        )}
        {weekly && (
          <div className="rw-dash-card">
            <div className="rw-dash-title">每周周报（#3 · KPI）</div>
            <div className="rw-dash-row"><span className={'rw-kb-tag ' + (weekly.enabled ? 'global' : 'conv')}>{weekly.enabled ? '运行中' : '已暂停'}</span>
              <span className="rw-dash-muted">上次 {weekly.last_run ? String(weekly.last_run).slice(0, 16) : '未运行'}</span></div>
            {weekly.last_result && <div className="rw-dash-result">{String(weekly.last_result).slice(0, 200)}</div>}
          </div>
        )}
      </div>

      <div style={{ marginTop: 16 }}><ProposalsManager /></div>

      <div className="rw-cap-gtitle" style={{ marginTop: 16 }}>最近操作审计（audit_log，redactSecrets 脱敏）</div>
      <table className="rw-console-table">
        <thead><tr><th>时间</th><th>动作</th><th>详情</th></tr></thead>
        <tbody>
          {audit.slice(0, 30).map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{String(r.created_at).slice(0, 16)}</td>
              <td><code>{r.action}</code></td>
              <td style={{ wordBreak: 'break-all' }}>{String(r.detail || '').slice(0, 160)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
