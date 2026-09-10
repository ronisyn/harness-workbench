// src/console/AuditBoard.jsx - A9 §8.10 审计页（独立于进化）：过滤器（时间范围/动作分类/壳/关键词）+ 流水表（详情默认收起点击展开，截断+悬停全文，脱敏）
// + 按会话回溯（audit × tool_calls 联动，对话页可跳）+ 90 天归档查询/手动归档。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

const CAT_CN = { tool: '工具', knowledge: '知识', ext: '扩展', shell: '壳管理', task: '任务', model: '模型/技能', auth: '登录' };

export default function AuditBoard({ onGoChat }) {
  const [rows, setRows] = useState([]);
  const [cats, setCats] = useState([]);
  const [stats, setStats] = useState(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [days, setDays] = useState(30);
  const [archived, setArchived] = useState('0');
  const [convId, setConvId] = useState('');
  const [shells, setShells] = useState([]);
  const [shellId, setShellId] = useState('');
  const [open, setOpen] = useState(null);       // 展开的审计行 id
  const [trace, setTrace] = useState(null);     // 按会话回溯结果
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const p = { limit: 200 };
      if (q.trim()) p.q = q.trim();
      if (cat) p.category = cat;
      if (days > 0) p.days = days;
      if (convId) p.conversation_id = convId;
      if (shellId) p.shell_id = shellId;
      p.archived = archived;
      const d = await api.auditQuery(p);
      setRows(d.audit || []);
      setCats(d.categories || []);
      setStats(await api.auditArchiveStats().catch(() => null));
    } catch (e) { setErr(e.message); }
  }, [q, cat, days, convId, shellId, archived]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.shells().then((s) => setShells((s.shells || []).filter((x) => x.skey !== 'default'))).catch(() => {}); }, []);
  // 从对话页跳入（/console/audit?conv=<id>）→ 预填会话回溯过滤
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const c = u.searchParams.get('conv');
      if (c) setConvId(String(c));
    } catch { /* ignore */ }
  }, []);

  const openTrace = async (id) => {
    setErr('');
    try { const d = await api.convTrace(id); setTrace(d); }
    catch (e) { setErr(e.message); }
  };
  const doArchive = async () => {
    if (!confirm('将 90 天前审计移入归档表？（主表减负，归档仍可查）')) return;
    try { const r = await api.auditArchive(90); setMsg('已归档 ' + r.moved + ' 行'); load(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">审计（全平台操作流水，redactSecrets 脱敏；独立于进化集 §8.10）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-kb-filters">
        <select className="rw-select" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">全部分类</option>
          {cats.map((c) => <option key={c} value={c}>{CAT_CN[c] || c}</option>)}
        </select>
        <select className="rw-select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>近 1 天</option>
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
          <option value={90}>近 90 天</option>
          <option value={0}>不限</option>
        </select>
        <select className="rw-select" value={shellId} onChange={(e) => setShellId(e.target.value)}>
          <option value="">全部壳</option>
          {shells.map((s) => <option key={s.id} value={s.id}>{s.name}（{s.skey}）</option>)}
        </select>
        <select className="rw-select" value={archived} onChange={(e) => setArchived(e.target.value)} title="归档查询（90 天前入归档表）">
          <option value="0">现行</option>
          <option value="1">仅归档</option>
          <option value="all">现行+归档</option>
        </select>
        <input className="rw-input" style={{ maxWidth: 150 }} placeholder="会话 id（按会话回溯）" value={convId} onChange={(e) => setConvId(e.target.value)} />
        <input className="rw-input" placeholder="关键词（动作/详情）" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
        <button className="rw-btn" onClick={load}>查询</button>
        <button className="rw-btn" onClick={doArchive} title="把 90 天前审计移入归档表">{'归档 >90 天'}</button>
      </div>
      {stats && <div className="rw-dash-muted" style={{ marginBottom: 6, fontSize: 12 }}>现行 {stats.current.rows} 行（最早 {stats.current.oldest ? String(stats.current.oldest).slice(0, 10) : '—'}）｜归档 {stats.archived.rows} 行（最早 {stats.archived.oldest ? String(stats.archived.oldest).slice(0, 10) : '—'}）</div>}

      <table className="rw-console-table">
        <thead><tr><th style={{ width: 130 }}>时间</th><th>动作</th><th>详情（点击展开）</th><th style={{ width: 80 }}>壳</th><th style={{ width: 90 }}>会话</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan="5" className="rw-empty">无匹配审计记录</td></tr>}
          {rows.map((r) => (
            <tr key={(r.archived ? 'a' : 'c') + r.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(open === r.id ? null : r.id)}>
              <td style={{ whiteSpace: 'nowrap' }}>{String(r.created_at).slice(0, 16)}{r.archived ? ' 📦' : ''}</td>
              <td><code>{r.action}</code></td>
              <td style={{ wordBreak: 'break-all' }}>
                {open === r.id
                  ? <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11.5 }}>{String(r.detail || '')}</pre>
                  : <span title={String(r.detail || '')}>{String(r.detail || '').slice(0, 110)}{String(r.detail || '').length > 110 ? '…' : ''}</span>}
              </td>
              <td>{r.shell_id ? ('#' + r.shell_id) : '-'}</td>
              <td>
                {r.conversation_id
                  ? <button className="rw-btn" style={{ padding: '1px 6px' }} onClick={(e) => { e.stopPropagation(); openTrace(r.conversation_id); }}>#{r.conversation_id}</button>
                  : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {trace && (
        <div className="rw-provider" style={{ marginTop: 12 }}>
          <div className="rw-dash-title">按会话回溯：#{trace.conversation.id}（{trace.conversation.title}）</div>
          <div className="rw-dash-muted">工具调用 {trace.usage.calls} 次 · 费用 ¥{Number(trace.usage.cost).toFixed(3)} · token in {trace.usage.tokensIn} / out {trace.usage.tokensOut}</div>
          <div className="rw-console-toolbar" style={{ marginTop: 6 }}>
            {onGoChat && <button className="rw-btn pri" onClick={() => onGoChat(trace.conversation.id)}>跳到该会话（对话页）</button>}
            <button className="rw-btn" onClick={() => setTrace(null)}>收起</button>
          </div>
          <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>工具轨迹（tool_calls）</div>
          <table className="rw-console-table">
            <thead><tr><th>时间</th><th>工具</th><th>状态</th><th>耗时</th></tr></thead>
            <tbody>
              {trace.toolCalls.length === 0 && <tr><td colSpan="4" className="rw-empty">该会话无工具调用</td></tr>}
              {trace.toolCalls.slice(0, 50).map((t) => (
                <tr key={t.id}><td>{String(t.created_at).slice(5, 16)}</td><td><code>{t.tool_name}</code></td><td>{t.status === 'done' ? '✅' : '❌'}</td><td>{t.duration_ms}ms</td></tr>
              ))}
            </tbody>
          </table>
          <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>该会话审计动作</div>
          <table className="rw-console-table">
            <thead><tr><th>时间</th><th>动作</th><th>详情</th></tr></thead>
            <tbody>
              {trace.audit.length === 0 && <tr><td colSpan="3" className="rw-empty">（审计中未记录该会话动作——工具类动作已带会话维度）</td></tr>}
              {trace.audit.slice(0, 50).map((a) => (
                <tr key={a.id}><td>{String(a.created_at).slice(5, 16)}</td><td><code>{a.action}</code></td><td style={{ wordBreak: 'break-all' }}>{String(a.detail || '').slice(0, 140)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="rw-console-note">过滤器=时间范围/动作分类（工具·知识·扩展·壳管理·任务·模型·登录）/壳/关键词；详情默认收起（点击展开，性能+敏感最小暴露），detail 已过 redactSecrets。90 天前审计自动入归档表（每日一次 + 启动补跑），归档仍可查（archived=1/all）。</div>
    </div>
  );
}
