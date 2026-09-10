// src/console/TasksBoard.jsx - A8 §8.10 任务页（独立板块）：列表卡（cron/指令摘要/模型/状态/上次结果 + 历史可展开）+ 新建 + ▶跑一次 + 启停/编辑/删除
// + 每任务绑进化目标（双向可见：任务页看绑了哪些目标；进化集看目标由哪些任务执行）+ 失败告警（首页状态带同源）。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function TasksBoard() {
  const [tasks, setTasks] = useState([]);
  const [goals, setGoals] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [hist, setHist] = useState({});       // taskId → rows
  const [openHist, setOpenHist] = useState(null);
  const [newTask, setNewTask] = useState({ name: '', cron: '30 2 * * *', prompt: '' });
  const [edit, setEdit] = useState(null);     // {id, name, cron, prompt}
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const [t, g, a] = await Promise.all([
        api.tasks(), api.evoGoals().catch(() => ({ goals: [] })), api.taskAlerts().catch(() => ({ alerts: [] })),
      ]);
      setTasks(t.tasks || []);
      setGoals(g.goals || []);
      setAlerts(a.alerts || []);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const ok = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2400); };

  const create = async () => {
    if (!newTask.name.trim() || !newTask.prompt.trim()) { setErr('名称与指令必填'); return; }
    try { await api.createTask(newTask); setNewTask({ name: '', cron: '30 2 * * *', prompt: '' }); ok('任务已创建'); load(); }
    catch (e) { setErr(e.message); }
  };
  const toggle = async (t) => { try { await api.patchTask(t.id, { enabled: !t.enabled }); load(); } catch (e) { setErr(e.message); } };
  const del = async (t) => { if (!confirm('删除任务「' + t.name + '」？执行历史一并删除')) return; try { await api.deleteTask(t.id); load(); } catch (e) { setErr(e.message); } };
  const runOnce = async (t) => {
    setBusy('run' + t.id);
    try { await api.runTaskOnce(t.id); ok('已触发「' + t.name + '」跑一次（后台执行）'); setTimeout(load, 1600); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };
  const showHist = async (t) => {
    if (openHist === t.id) { setOpenHist(null); return; }
    setOpenHist(t.id);
    try { const h = await api.taskHistory(t.id, 10); setHist((o) => ({ ...o, [t.id]: h.history || [] })); }
    catch (e) { setErr(e.message); }
  };
  const saveEdit = async () => {
    try { await api.patchTask(edit.id, { name: edit.name, cron: edit.cron, prompt: edit.prompt }); setEdit(null); ok('已保存'); load(); }
    catch (e) { setErr(e.message); }
  };
  // 目标绑定（按目标侧整表替换：勾选=该目标在此任务上执行）
  const bindGoal = async (goal, taskId, on) => {
    const cur = (goal.taskIds || []).filter((x) => x !== taskId);
    const next = on ? [...cur, taskId] : cur;
    try { await api.evoGoalBind(goal.id, next); load(); }
    catch (e) { setErr(e.message); }
  };
  const goalsOfTask = (taskId) => goals.filter((g) => (g.taskIds || []).includes(taskId));

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">任务（§8.10：定时任务机制 + 执行历史 + 绑进化目标；▶跑一次=手动补跑+审计）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      {alerts.length > 0 && (
        <div className="rw-kb-err" style={{ background: '#fff8e6', color: '#8a6d1a' }}>
          ⚠️ 近 24h 失败告警（同源首页状态带/进化集审批台）：{alerts.map((a) => a.name + '（' + String(a.finished_at).slice(5, 16) + '）').join('；')}
        </div>
      )}
      <div className="rw-task-new">
        <input className="rw-input" placeholder="任务名称" value={newTask.name} onChange={(e) => setNewTask({ ...newTask, name: e.target.value })} />
        <input className="rw-input" placeholder="cron（分 时 日 月 周，如 30 2 * * *）" value={newTask.cron} onChange={(e) => setNewTask({ ...newTask, cron: e.target.value })} />
        <textarea className="rw-input" rows="2" placeholder="要 AI 执行的指令…（可绑进化目标，到点逐条执行）" value={newTask.prompt} onChange={(e) => setNewTask({ ...newTask, prompt: e.target.value })} />
        <button className="rw-btn pri" onClick={create} disabled={!newTask.name || !newTask.prompt}>＋ 创建任务</button>
      </div>

      {tasks.map((t) => {
        const bound = goalsOfTask(t.id);
        const failed = alerts.some((a) => a.task_id === t.id);
        const isEvo = /每日自我进化|周报|KPI|巡检/.test(String(t.name));
        return (
          <div key={t.id} className="rw-task-item" style={failed ? { borderColor: '#d9534f' } : {}}>
            <div className="rw-task-head">
              <b>{t.name}</b>
              {isEvo && <span className="rw-provider-model" title="进化任务（可在进化集查看绑定目标）">进化任务</span>}
              <span className={'rw-task-cron ' + (t.enabled ? 'on' : '')}>{t.enabled ? '● 运行中' : '○ 已暂停'}</span>
              {failed && <span className="rw-provider-model off">近 24h 失败</span>}
            </div>
            <div className="rw-task-meta">{t.cron} ｜ {t.provider}/{t.model} ｜ 下次 {t.next_run ? String(t.next_run).slice(0, 16) : '待排'}</div>
            {edit && edit.id === t.id ? (
              <div className="rw-provider" style={{ marginTop: 6 }}>
                <input className="rw-input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                <input className="rw-input" style={{ marginTop: 4 }} value={edit.cron} onChange={(e) => setEdit({ ...edit, cron: e.target.value })} />
                <textarea className="rw-input" rows="3" style={{ marginTop: 4 }} value={edit.prompt} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} />
                <div className="rw-console-toolbar" style={{ marginTop: 4 }}>
                  <button className="rw-btn pri" onClick={saveEdit}>保存</button>
                  <button className="rw-btn" onClick={() => setEdit(null)}>取消</button>
                </div>
              </div>
            ) : (
              <div className="rw-task-prompt">{String(t.prompt).slice(0, 120)}</div>
            )}
            {t.last_run && <div className="rw-task-last">上次：{String(t.last_run).slice(0, 16)}｜{String(t.last_result || '').slice(0, 80)}</div>}

            <div className="rw-provider-models" style={{ marginTop: 4 }}>
              <span className="rw-dash-muted" style={{ fontSize: 11 }}>绑定进化目标：</span>
              {goals.length === 0 && <span className="rw-dash-muted" style={{ fontSize: 11 }}>（进化集暂无目标）</span>}
              {goals.map((g) => {
                const on = (g.taskIds || []).includes(t.id);
                return (
                  <span key={g.id} className={'rw-provider-model' + (on ? ' on' : '')} style={{ cursor: 'pointer' }} title={on ? '已绑定：到点执行该目标' : '点击绑定'}
                    onClick={() => bindGoal(g, t.id, !on)}>
                    {on ? '✓ ' : ''}{g.name}{g.status === 'paused' ? '(停)' : ''}
                  </span>
                );
              })}
              {bound.length > 0 && <span className="rw-dash-muted" style={{ fontSize: 11 }}>共 {bound.length} 个目标</span>}
            </div>

            <div className="rw-task-ops">
              <button className="rw-btn pri" disabled={busy === 'run' + t.id} onClick={() => runOnce(t)}>{busy === 'run' + t.id ? '触发中…' : '▶ 跑一次'}</button>
              <button className="rw-btn" onClick={() => toggle(t)}>{t.enabled ? '暂停' : '启用'}</button>
              <button className="rw-btn" onClick={() => setEdit({ id: t.id, name: t.name, cron: t.cron, prompt: t.prompt })}>编辑</button>
              <button className="rw-btn" onClick={() => showHist(t)}>{openHist === t.id ? '收起历史' : '执行历史'}</button>
              <button className="rw-btn" onClick={() => del(t)}>删除</button>
            </div>
            {openHist === t.id && (
              <table className="rw-console-table" style={{ marginTop: 6 }}>
                <thead><tr><th>开始</th><th>结束</th><th>结果</th><th>摘要</th></tr></thead>
                <tbody>
                  {(hist[t.id] || []).length === 0 && <tr><td colSpan="4" className="rw-empty">暂无执行历史（跑一次后记录）</td></tr>}
                  {(hist[t.id] || []).map((h) => (
                    <tr key={h.id}>
                      <td>{String(h.started_at || '').slice(0, 16)}</td>
                      <td>{h.finished_at ? String(h.finished_at).slice(0, 16) : '运行中'}</td>
                      <td>{h.ok ? '✅ 成功' : '❌ 失败'}</td>
                      <td style={{ wordBreak: 'break-all' }}>{String(h.note || '').slice(0, 120)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
      {!tasks.length && <div className="rw-empty">暂无定时任务</div>}
      <div className="rw-console-note">每任务可绑多个进化目标（任务页勾选=该目标在此任务上执行；进化集页反向可见）。失败告警同时进首页状态带与进化集审批台记录（同源 task_history，近 24h）。计划频率（日/周/月）由 cron 自行配置——知识库月度巡检已按此体系预置。</div>
    </div>
  );
}
