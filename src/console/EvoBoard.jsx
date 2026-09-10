// src/console/EvoBoard.jsx - A7 §8.7 进化集（v2）：状态行 + 运行载体卡（每日自我进化/周报/巡检，▶跑一次）+ 进化目标卡区（人控事项+任务勾选绑定）
// + 审批台卡区（需求待审/提案）+ 备忘录区（仅建议类落点）+ 进化护栏三条 + 最近审计流水。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import ProposalsManager from '../shared/ProposalsManager.jsx';

const TASKS_FALLBACK = [];
export default function EvoBoard() {
  const [sum, setSum] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [goals, setGoals] = useState([]);
  const [demands, setDemands] = useState([]);
  const [memos, setMemos] = useState([]);
  const [audit, setAudit] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [newGoal, setNewGoal] = useState({ name: '', descr: '' });
  const [newMemo, setNewMemo] = useState('');
  const [bindEdit, setBindEdit] = useState(null);   // 正在编辑绑定的目标 id
  const [bindSel, setBindSel] = useState([]);

  const load = useCallback(async () => {
    setErr('');
    const safe = (p, fb) => p.catch((e) => { setErr('部分数据加载失败：' + (e.message || e)); return fb; });
    const [s, t, g, d, m, a] = await Promise.all([
      safe(api.evoSummary(), { ok: false }),
      safe(api.tasks(), { tasks: TASKS_FALLBACK }),
      safe(api.evoGoals(), { goals: [] }),
      safe(api.demands({ status: '待审' }), { demands: [] }),
      safe(api.evoMemos(), { memos: [] }),
      safe(api.audit(30), { audit: [] }),
    ]);
    setSum(s && s.ok ? s : null);
    setTasks(t.tasks || []);
    setGoals(g.goals || []);
    setDemands(d.demands || []);
    setMemos(m.memos || []);
    setAudit(a.audit || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const tell = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2600); };

  const runOnce = async (t) => {
    setBusy('run' + t.id);
    try { await api.runTaskOnce(t.id); tell('已触发「' + t.name + '」跑一次（后台执行，完成后历史可见）'); setTimeout(load, 1500); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };
  // A8：任务失败告警（近 24h）——状态带数据源同源
  const [alerts, setAlerts] = useState([]);
  useEffect(() => { api.taskAlerts().then((d) => setAlerts(d.alerts || [])).catch(() => {}); }, [sum]);

  const addGoal = async () => {
    if (!newGoal.name.trim()) { setErr('目标名称必填（一句事项描述）'); return; }
    try { await api.evoGoalCreate(newGoal); setNewGoal({ name: '', descr: '' }); tell('已新增进化目标'); load(); }
    catch (e) { setErr(e.message); }
  };
  const toggleGoal = async (g) => {
    try { await api.evoGoalPatch(g.id, { status: g.status === 'active' ? 'paused' : 'active' }); load(); }
    catch (e) { setErr(e.message); }
  };
  const delGoal = async (g) => {
    if (!confirm('删除目标「' + g.name + '」？（绑定关系一并移除，任务本身保留）')) return;
    try { await api.evoGoalDelete(g.id); load(); } catch (e) { setErr(e.message); }
  };
  const openBind = (g) => { setBindEdit(g.id); setBindSel(g.taskIds || []); };
  const saveBind = async () => {
    try { await api.evoGoalBind(bindEdit, bindSel); setBindEdit(null); tell('已保存目标×任务绑定'); load(); }
    catch (e) { setErr(e.message); }
  };
  const addMemo = async () => {
    if (!newMemo.trim()) return;
    try { await api.evoMemoCreate(newMemo); setNewMemo(''); load(); } catch (e) { setErr(e.message); }
  };
  const toggleMemo = async (m) => { try { await api.evoMemoPatch(m.id, { done: !m.done }); load(); } catch (e) { setErr(e.message); } };
  const delMemo = async (m) => { try { await api.evoMemoDelete(m.id); load(); } catch (e) { setErr(e.message); } };
  const decideDemand = async (d, status) => {
    try { await api.demandStatus(d.id, status); tell('需求 #' + d.id + ' → ' + status); load(); }
    catch (e) { setErr(e.message); }
  };

  const daily = (sum && sum.daily) || tasks.find((t) => /每日自我进化/.test(String(t.name)));
  const kpi = (sum && sum.kpi) || tasks.find((t) => /周报|KPI/.test(String(t.name)));
  const patrol = tasks.find((t) => /巡检/.test(String(t.name)));

  return (
    <div className="rw-cap-group">
      {/* ① 状态行 */}
      <div className="rw-cap-gtitle">进化集 · 状态行（平台及各壳 Agent 自我进化的管理与审批中枢 §8.7）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-dash-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))' }}>
        <div className="rw-dash-card">
          <div className="rw-dash-title">每日进化</div>
          <div className="rw-dash-row">
            <span className={'rw-kb-tag ' + (daily && daily.enabled ? 'global' : 'conv')}>{daily ? (daily.enabled ? '运行中' : '已暂停') : '未配置'}</span>
            <span className="rw-dash-muted">{daily && daily.last_run ? '上次 ' + String(daily.last_run).slice(0, 16) : '未运行'}</span>
          </div>
        </div>
        <div className="rw-dash-card">
          <div className="rw-dash-title">启用目标</div>
          <div className="rw-dash-row"><b style={{ fontSize: 20 }}>{sum ? sum.activeGoals : (goals.filter((g) => g.status === 'active').length)}</b><span className="rw-dash-muted">个（人控事项）</span></div>
        </div>
        <div className="rw-dash-card">
          <div className="rw-dash-title">待审建议</div>
          <div className="rw-dash-row"><b style={{ fontSize: 20 }}>{demands.length}</b><span className="rw-dash-muted">条需求待审</span></div>
          {sum && <div className="rw-dash-muted" style={{ fontSize: 11 }}>提案文件 {sum.proposalFiles} · 定时任务 {sum.taskCount}</div>}
        </div>
        <div className="rw-dash-card">
          <div className="rw-dash-title">任务失败告警</div>
          <div className="rw-dash-row"><b style={{ fontSize: 20, color: alerts.length ? '#c62828' : undefined }}>{alerts.length}</b><span className="rw-dash-muted">近 24h</span></div>
          {alerts.slice(0, 1).map((a) => <div key={a.task_id + a.finished_at} className="rw-dash-muted" style={{ fontSize: 11 }}>{a.name}：{String(a.note || '').slice(0, 60)}</div>)}
        </div>
      </div>

      {/* ② 运行载体卡 */}
      <div className="rw-cap-gtitle" style={{ marginTop: 14 }}>运行载体（定时任务：卡上可 执行目标 标签 + ▶跑一次）</div>
      <div className="rw-dash-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
        {[daily, kpi, patrol].filter(Boolean).map((t) => (
          <div key={t.id} className="rw-dash-card">
            <div className="rw-dash-title">{/巡检/.test(String(t.name)) ? '🧹 ' : /周报|KPI/.test(String(t.name)) ? '📈 ' : '🔄 '}{t.name}</div>
            <div className="rw-dash-row">
              <span className={'rw-kb-tag ' + (t.enabled ? 'global' : 'conv')}>{t.enabled ? '运行中' : '已暂停'}</span>
              <span className="rw-dash-muted">上次 {t.last_run ? String(t.last_run).slice(0, 16) : '未运行'}</span>
              {goals.some((g) => (g.taskIds || []).includes(t.id)) && <span className="rw-provider-model">执行目标 {goals.filter((g) => (g.taskIds || []).includes(t.id)).length}</span>}
            </div>
            {t.last_result && <div className="rw-dash-result">{String(t.last_result).slice(0, 180)}</div>}
            <div className="rw-console-toolbar" style={{ marginTop: 6 }}>
              <button className="rw-btn pri" disabled={busy === 'run' + t.id} onClick={() => runOnce(t)}>{busy === 'run' + t.id ? '触发中…' : '▶ 跑一次'}</button>
            </div>
          </div>
        ))}
        {!daily && !kpi && !patrol && <div className="rw-dash-muted">（暂无运行载体任务——可在「任务」页新建）</div>}
      </div>

      {/* ③ 进化目标卡区 */}
      <div className="rw-cap-gtitle" style={{ marginTop: 16 }}>进化目标（一句事项描述；无验收值，不做达成判定——勾选绑定定时任务，任务到点逐条执行）</div>
      <div className="rw-console-toolbar" style={{ flexWrap: 'wrap', gap: 6 }}>
        <input className="rw-input" style={{ maxWidth: 260 }} placeholder="目标事项描述（如：优化 token 成本 / 巡检知识库冗余）" value={newGoal.name} onChange={(e) => setNewGoal((g) => ({ ...g, name: e.target.value }))} />
        <input className="rw-input" style={{ maxWidth: 220 }} placeholder="补充说明（可空）" value={newGoal.descr} onChange={(e) => setNewGoal((g) => ({ ...g, descr: e.target.value }))} />
        <button className="rw-btn pri" onClick={addGoal}>＋ 新建目标</button>
      </div>
      <div className="rw-dash-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', marginTop: 8 }}>
        {goals.length === 0 && <div className="rw-dash-muted">（暂无进化目标）</div>}
        {goals.map((g) => (
          <div key={g.id} className="rw-dash-card" style={g.status !== 'active' ? { opacity: 0.6 } : {}}>
            <div className="rw-dash-title">{g.name} <span className={'rw-kb-tag ' + (g.status === 'active' ? 'global' : 'conv')}>{g.status === 'active' ? '启用' : '已暂停'}</span></div>
            {g.descr && <div className="rw-dash-muted" style={{ fontSize: 12 }}>{g.descr}</div>}
            <div className="rw-provider-models" style={{ marginTop: 4 }}>
              {(g.taskIds || []).length === 0 && <span className="rw-dash-muted" style={{ fontSize: 11 }}>未绑定任务（无任务执行则目标空转）</span>}
              {(g.taskIds || []).map((id) => { const t = tasks.find((x) => x.id === id); return <span key={id} className="rw-provider-model">{(t && t.name) || ('#' + id)}</span>; })}
            </div>
            <div className="rw-console-toolbar" style={{ marginTop: 6 }}>
              <button className="rw-btn" onClick={() => openBind(g)}>绑定任务</button>
              <button className="rw-btn" onClick={() => toggleGoal(g)}>{g.status === 'active' ? '暂停' : '启用'}</button>
              <button className="rw-btn" onClick={() => delGoal(g)}>删除</button>
            </div>
            {bindEdit === g.id && (
              <div className="rw-provider" style={{ marginTop: 6 }}>
                <div className="rw-cap-gtitle">勾选执行本目标的定时任务（到点逐条执行；任务页可见反向绑定）</div>
                <div className="rw-provider-models">
                  {tasks.map((t) => (
                    <span key={t.id} className={'rw-provider-model' + (bindSel.includes(t.id) ? ' on' : '')} style={{ cursor: 'pointer' }}
                      onClick={() => setBindSel((s) => s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id])}>
                      {t.name}{t.enabled ? '' : '(停)'}
                    </span>
                  ))}
                </div>
                <div className="rw-console-toolbar" style={{ marginTop: 6 }}>
                  <button className="rw-btn pri" onClick={saveBind}>保存绑定</button>
                  <button className="rw-btn" onClick={() => setBindEdit(null)}>取消</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ④ 审批台卡区 */}
      <div className="rw-cap-gtitle" style={{ marginTop: 16 }}>审批台（待审建议按时间排；采纳→按类型分派：技能→技能库候选 / 插件·应用·工具→立项 intake / 平台 bug·成本→提案；仅建议类→备忘录）</div>
      {demands.length === 0 && <div className="rw-dash-muted">（暂无待审需求/建议）</div>}
      {demands.map((d) => (
        <div key={d.id} className="rw-provider" style={{ padding: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 12 }}>
            <span className="rw-provider-model">{d.kindCn}</span>
            <span className="rw-provider-model">来源：{d.source}</span>
            <span className="rw-provider-model">资产：{d.asset_key || '（通用）'}</span>
            <span className="rw-dash-muted">#{d.id} · {String(d.created_at).slice(0, 16)}</span>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '4px 0' }}>{d.content}</pre>
          <div className="rw-console-toolbar">
            <button className="rw-btn pri" onClick={() => decideDemand(d, '采纳')}>采纳（立项/升级）</button>
            <button className="rw-btn" onClick={() => decideDemand(d, '升级')}>标记升级</button>
            <button className="rw-btn" onClick={() => decideDemand(d, '驳回')}>驳回</button>
            <button className="rw-btn" onClick={() => api.evoMemoCreate('【建议转入】' + String(d.content).slice(0, 300)).then(() => { tell('已转入备忘录区'); load(); })}>仅建议→备忘录</button>
          </div>
        </div>
      ))}

      <div style={{ marginTop: 12 }}><ProposalsManager /></div>

      {/* ⑤ 备忘录区 */}
      <div className="rw-cap-gtitle" style={{ marginTop: 16 }}>备忘录区（仅建议类落点：你决定做不做，不自动执行）</div>
      <div className="rw-console-toolbar">
        <input className="rw-input" style={{ flex: 1 }} placeholder="记一条备忘（建议/想法，稍后决定）" value={newMemo} onChange={(e) => setNewMemo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addMemo(); }} />
        <button className="rw-btn pri" onClick={addMemo}>＋ 记备忘</button>
      </div>
      <div style={{ marginTop: 6 }}>
        {memos.length === 0 && <div className="rw-dash-muted">（暂无备忘）</div>}
        {memos.map((m) => (
          <div key={m.id} className="rw-provider" style={{ padding: 6, marginBottom: 4, opacity: m.done ? 0.55 : 1 }}>
            <div style={{ fontSize: 12.5 }}>
              <input type="checkbox" checked={!!m.done} onChange={() => toggleMemo(m)} style={{ marginRight: 6 }} />
              <span style={{ textDecoration: m.done ? 'line-through' : 'none' }}>{m.content}</span>
              <button className="rw-conv-del" style={{ float: 'right' }} onClick={() => delMemo(m)} title="删除">✕</button>
            </div>
          </div>
        ))}
      </div>

      {/* ⑥ 进化护栏（三条，§8.7） */}
      <div className="rw-cap-gtitle" style={{ marginTop: 16 }}>进化护栏（三条）</div>
      <div className="rw-console-note">
        ① 每日自我进化属平台自身改动 → 遵循平台 main 铁律（提案 → 你审批 → 才实施），不得自我放行；
        ② 单轮自进化产出提案数设上限（防刷屏）——超限的候选转备忘录区排队；
        ③ 建议采纳率过低时季度复盘一次（防机制空转）——本页状态行与审批台即复盘数据源。
      </div>

      <div className="rw-cap-gtitle" style={{ marginTop: 16 }}>最近操作审计（audit_log，已脱敏）</div>
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
