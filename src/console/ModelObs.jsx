// src/console/ModelObs.jsx - A7 §8.4 模型观测：telemetry 按日视图 + 缓存命中率列 + 复测记录（难度勾选）+ 一次通过率（按模型×难度）
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

const DIFFS = ['小', '中', '大'];

export default function ModelObs() {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [convs, setConvs] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({ conversationId: '', result: 'pass', difficulty: '中', bugReason: '' });

  const load = useCallback(async (d) => {
    try {
      const t = await api.telemetryDaily({ days: d });
      setRows(t.rows || []);
      setTotal(t.total || null);
    } catch (e) { setErr(e.message); }
  }, []);
  const loadReviews = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([api.reviewsList({}), api.conversations().catch(() => ({ conversations: [] }))]);
      setReviews(r.reviews || []);
      setConvs(c.conversations || []);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(days); }, [days, load]);
  useEffect(() => { loadReviews(); }, [loadReviews]);

  const fmt = (n) => Number(n || 0).toLocaleString();
  const dayLb = (d) => String(d || '').slice(0, 10);

  // 一次通过率 v1（§7.4 口径）：reviews × 会话主模型归集；A7：叠加难度维度
  const modelOf = (cid) => { const c = convs.find((x) => x.id === cid); return c ? (c.model || c.provider || '（自动）') : '（会话已删）'; };
  const rate = (() => {
    const m = {};
    for (const r of reviews) {
      const key = modelOf(r.conversation_id) + ' · ' + (r.difficulty || '未标');
      m[key] = m[key] || { n: 0, pass: 0 };
      m[key].n++;
      if (r.result === 'pass') m[key].pass++;
    }
    return Object.entries(m).map(([k, v]) => ({ k, n: v.n, pass: v.pass, rate: Math.round((v.pass / v.n) * 100) })).sort((a, b) => b.n - a.n);
  })();

  const submitReview = async () => {
    setErr(''); setMsg('');
    const cid = Number(form.conversationId);
    if (!cid) { setErr('请填会话 id（对话页左侧会话编号）'); return; }
    if (form.result === 'bug' && !form.bugReason.trim()) { setErr('打回必须填写原因（打回必填原因口径 §7.4）'); return; }
    try {
      await api.reviewsAdd(cid, form.result, form.result === 'bug' ? form.bugReason : '', form.difficulty);
      setMsg('已登记复测（难度 ' + form.difficulty + '）');
      setForm((f) => ({ ...f, bugReason: '' }));
      loadReviews();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">模型观测（执行事实 · 按天 × 壳 × 厂商 × 模型 §8.4）</div>
      <div className="rw-console-toolbar">
        <span>统计范围</span>
        {[3, 7, 14, 30].map((d) => (
          <button key={d} className={'rw-btn' + (days === d ? ' pri' : '')} onClick={() => setDays(d)}>{d} 天</button>
        ))}
      </div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      {total && (
        <div className="rw-dash-nums" style={{ marginBottom: 12 }}>
          <div className="rw-dash-num"><b>{fmt(total.execs)}</b><span>执行</span></div>
          <div className="rw-dash-num"><b>{fmt(total.tokens_in)}</b><span>输入 tok</span></div>
          <div className="rw-dash-num"><b>{fmt(total.tokens_out)}</b><span>输出 tok</span></div>
          <div className="rw-dash-num"><b>¥{Number(total.cost || 0).toFixed(3)}</b><span>费用</span></div>
        </div>
      )}
      <table className="rw-console-table">
        <thead><tr><th>日期</th><th>壳</th><th>厂商</th><th>模型</th><th>执行</th><th>输入 tok</th><th>输出 tok</th><th>费用</th><th>时长</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan="9" className="rw-empty">暂无观测数据（对话执行后自动落 model_telemetry）</td></tr>}
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{dayLb(r.d)}</td>
              <td>{r.shell_id ? ('#' + r.shell_id) : '默认'}</td>
              <td>{r.provider || '-'}</td>
              <td>{r.model || '-'}</td>
              <td>{r.execs}</td>
              <td>{fmt(r.tokens_in)}</td>
              <td>{fmt(r.tokens_out)}</td>
              <td>¥{Number(r.cost || 0).toFixed(4)}</td>
              <td>{((Number(r.duration_ms) || 0) / 1000).toFixed(0)}s</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* A7 复测登记（难度人工勾选：小/中/大；打回必填原因） */}
      <div className="rw-cap-gtitle" style={{ marginTop: 22 }}>登记复测（对照验收自检后登记；难度人工勾选，用于 模型×难度 一次通过率）</div>
      <div className="rw-console-toolbar" style={{ flexWrap: 'wrap', gap: 6 }}>
        <input className="rw-input" style={{ width: 120 }} placeholder="会话 id" value={form.conversationId} onChange={(e) => setForm((f) => ({ ...f, conversationId: e.target.value }))} />
        <select className="rw-select" value={form.result} onChange={(e) => setForm((f) => ({ ...f, result: e.target.value }))}>
          <option value="pass">通过</option>
          <option value="bug">打回（必填原因）</option>
        </select>
        <select className="rw-select" value={form.difficulty} onChange={(e) => setForm((f) => ({ ...f, difficulty: e.target.value }))} title="难度（人工勾选 v1）">
          {DIFFS.map((d) => <option key={d} value={d}>难度：{d}</option>)}
        </select>
        <input className="rw-input" style={{ flex: 1, minWidth: 180 }} placeholder="打回原因（result=bug 必填）" value={form.bugReason} onChange={(e) => setForm((f) => ({ ...f, bugReason: e.target.value }))} />
        <button className="rw-btn pri" onClick={submitReview}>登记</button>
      </div>

      <div className="rw-cap-gtitle" style={{ marginTop: 14 }}>一次通过率（reviews × 会话主模型 × 难度；v1 口径 §7.4）</div>
      <table className="rw-console-table">
        <thead><tr><th>模型 · 难度</th><th>复测数</th><th>通过</th><th>一次通过率</th></tr></thead>
        <tbody>
          {rate.length === 0 && <tr><td colSpan="4" className="rw-empty">暂无复测数据</td></tr>}
          {rate.map((r) => <tr key={r.k}><td>{r.k}</td><td>{r.n}</td><td>{r.pass}</td><td><b>{r.rate}%</b></td></tr>)}
        </tbody>
      </table>

      <div className="rw-cap-gtitle" style={{ marginTop: 22 }}>复测记录（reviews）</div>
      <table className="rw-console-table">
        <thead><tr><th>时间</th><th>会话</th><th>模型</th><th>难度</th><th>结果</th><th>原因</th></tr></thead>
        <tbody>
          {reviews.length === 0 && <tr><td colSpan="6" className="rw-empty">暂无复测记录</td></tr>}
          {reviews.map((r) => (
            <tr key={r.id}>
              <td>{String(r.created_at).slice(0, 16)}</td>
              <td>{r.conversation_id}</td>
              <td>{modelOf(r.conversation_id)}</td>
              <td>{r.difficulty || '未标'}</td>
              <td>{r.result === 'pass' ? '✅ 通过' : '🔁 打回'}</td>
              <td>{r.bug_reason || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rw-console-note">难度=人工勾选（v1，自动估算挂 v2）；一次通过率按 reviews×会话主模型×难度归集（跨壳对比归本后台）。缓存命中率目标链路见首页状态带与设置→观测组。</div>
    </div>
  );
}
