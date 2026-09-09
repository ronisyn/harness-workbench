// src/console/ToolUsageBoard.jsx - §8.5 工具使用率看板（数据=近 7/30 天 tool_calls，无埋点）：调用/失败/均耗时/热度；供工具淘汰决策参考
import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

export default function ToolUsageBoard() {
  const [u, setU] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.getToolUsage().then(setU).catch((e) => setErr(e.message)); }, []);
  const rows = u ? u.d30 : [];
  const max30 = Math.max(1, ...rows.map((r) => r.calls));
  return (
    <div className="rw-cap-group" style={{ marginTop: 12 }}>
      <div className="rw-cap-gtitle">工具使用率看板（近 7/30 天；淘汰/默认集调整以数据为准——先展示，不禁用不删除）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {!u && !err && <div className="rw-dash-muted">加载中…</div>}
      {u && (
        <div style={{ fontSize: 12 }}>
          <div className="rw-dash-muted" style={{ marginBottom: 6 }}>🔥=30d 调用 ≥ 头部一半（热）；❄=30d 有调用但远低于头部（冷）。悬停工具名可对「扩展/淘汰」做初步判断——最终以你的决定为准。</div>
          <table className="rw-console-table" style={{ fontSize: 12 }}>
            <thead><tr><th>工具</th><th>7d 调用</th><th>30d 调用</th><th>失败</th><th>失败率</th><th>均耗时 ms</th><th>热度</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan="7">（暂无 tool_calls 数据）</td></tr>}
              {rows.map((r) => {
                const r7 = (u.d7 || []).find((x) => x.tool === r.tool);
                const h = r.calls >= max30 * 0.5;
                return (
                  <tr key={r.tool}>
                    <td><b>{r.cn}</b> <code style={{ fontSize: 10, color: 'var(--rw-muted)' }}>{r.tool}</code></td>
                    <td>{r7 ? r7.calls : 0}</td>
                    <td>{r.calls}</td>
                    <td style={r.fails ? { color: '#c62828' } : {}}>{r.fails}</td>
                    <td>{Math.round(r.failRate * 100)}%</td>
                    <td>{r.avgMs}</td>
                    <td>{r.calls ? (h ? '🔥 热' : '❄ 冷') : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

