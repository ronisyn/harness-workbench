// src/console/CapsBoard.jsx - 1.4 Agent 能力（能力开关 A/B/C + 工具启用集 + allow/deny 规则）
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function CapsBoard() {
  const [caps, setCaps] = useState([]);
  const [tools, setTools] = useState([]);
  const [rules, setRules] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, t, r] = await Promise.all([api.capabilities(), api.getToolset(), api.getRules()]);
      setCaps(c.list || []);
      setTools(t.tools || []);
      setRules(r.rules || []);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggleCap = async (key, enabled) => {
    try { await api.setCapabilities({ [key]: enabled }); setCaps((cs) => cs.map((c) => (c.key === key ? { ...c, enabled } : c))); }
    catch (e) { setErr(e.message); }
  };
  const toggleTool = async (name, on) => {
    try {
      // 启用集只含非豁免项（defaultOn=平台豁免恒开，服务端强制；计算时排除防假状态——审计 P2-4）
      const cur = tools.filter((x) => x.enabled && !x.defaultOn).map((x) => x.name);
      const next = on ? [...cur, name] : cur.filter((n) => n !== name);
      await api.setToolset(next);
      setTools((ts) => ts.map((x) => (x.name === name ? { ...x, enabled: on } : x)));
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="rw-cap-group">
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-cap-gtitle">能力开关（平台/工具/渲染三组）</div>
      {['A', 'B', 'C'].map((g) => (
        <div key={g} className="rw-cap-group">
          <div className="rw-console-toolbar">
            {caps.filter((c) => c.group === g).map((c) => (
              <label key={c.key} className="rw-market-m">
                <input type="checkbox" checked={c.enabled} onChange={(e) => toggleCap(c.key, e.target.checked)} />
                <span>{c.name}</span>
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="rw-cap-gtitle">工具启用集（平台豁免工具恒可用不可关；会话内还受壳 preset∩force 约束）</div>
      <div className="rw-console-toolbar">
        {tools.map((t) => (
          <label key={t.name} className="rw-market-m" title={t.defaultOn ? '平台豁免工具：恒可用不可关闭' : undefined}>
            <input type="checkbox" checked={Boolean(t.enabled)} disabled={Boolean(t.defaultOn)} onChange={(e) => toggleTool(t.name, e.target.checked)} />
            <span>{t.name}</span>
          </label>
        ))}
      </div>

      <div className="rw-cap-gtitle">allow/deny 规则（access_rules：工具名正则 + 可选参数正则 → allow|deny）</div>
      <div className="rw-dash-muted" style={{ marginBottom: 8 }}>规则编辑当前在「对话页 → ⚙ 设置 → 规则」维护；此处只读展示当前生效规则。</div>
      <table className="rw-console-table">
        <thead><tr><th>工具正则</th><th>参数正则</th><th>动作</th><th>原因</th></tr></thead>
        <tbody>
          {rules.length === 0 && <tr><td colSpan="4" className="rw-empty">无规则</td></tr>}
          {rules.map((r) => (
            <tr key={r.id}>
              <td><code>{r.pattern}</code></td>
              <td>{r.argPattern ? <code>{r.argPattern}</code> : '-'}</td>
              <td>{r.action === 'deny' ? '🔒 拒绝' : '✅ 放行'}</td>
              <td>{r.why || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
