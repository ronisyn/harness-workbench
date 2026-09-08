// src/console/ModelObs.jsx - 1.2 模型观测（§6.4/⑤：telemetry 按日视图 + reviews 复测记录）
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function ModelObs() {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [err, setErr] = useState('');

  const load = useCallback(async (d) => {
    try {
      const t = await api.telemetryDaily({ days: d });
      setRows(t.rows || []);
      setTotal(t.total || null);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(days); }, [days, load]);
  useEffect(() => { api.reviewsList({}).then((r) => setReviews(r.reviews || [])).catch(() => {}); }, []);

  const fmt = (n) => Number(n || 0).toLocaleString();
  const dayLb = (d) => String(d || '').slice(0, 10);

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">模型观测（执行事实 · 按天 × 壳 × 厂商 × 模型）</div>
      <div className="rw-console-toolbar">
        <span>统计范围</span>
        {[3, 7, 14, 30].map((d) => (
          <button key={d} className={'rw-btn' + (days === d ? ' pri' : '')} onClick={() => setDays(d)}>{d} 天</button>
        ))}
      </div>
      {err && <div className="rw-kb-err">{err}</div>}
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

      <div className="rw-cap-gtitle" style={{ marginTop: 22 }}>复测记录（reviews · 一次通过率信号）</div>
      <table className="rw-console-table">
        <thead><tr><th>时间</th><th>会话</th><th>结果</th><th>原因</th></tr></thead>
        <tbody>
          {reviews.length === 0 && <tr><td colSpan="4" className="rw-empty">暂无复测记录</td></tr>}
          {reviews.map((r) => (
            <tr key={r.id}>
              <td>{String(r.created_at).slice(0, 16)}</td>
              <td>{r.conversation_id}</td>
              <td>{r.result === 'pass' ? '✅ 通过' : '🔁 打回'}</td>
              <td>{r.bug_reason || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rw-console-note">难度人工勾选与一次通过率联动展示随 M 系列；跨壳对比归本后台。</div>
    </div>
  );
}
