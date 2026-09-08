// src/shared/CapSwitches.jsx - R1 单一事实源：能力开关（A/B/C 三组复选框）
// 对话页⚙设置→能力 与 1.4 Agent 能力 共用；数据自管（GET/PUT /api/capabilities）。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function CapSwitches({ onToast, groupNames, showGroupTitle = true }) {
  const [caps, setCaps] = useState([]);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { const d = await api.capabilities(); setCaps(d.list || []); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const toggleCap = async (key, v) => {
    setCaps((c) => c.map((x) => (x.key === key ? { ...x, enabled: v } : x)));
    try { await api.setCapabilities({ [key]: v }); }
    catch (e) { setCaps((c) => c.map((x) => (x.key === key ? { ...x, enabled: !v } : x))); if (onToast) onToast('开关保存失败：' + (e.message || e)); else setErr(e.message); }
  };
  return (
    <div>
      {showGroupTitle && <div className="rw-cap-gtitle">能力开关（平台/工具/渲染三组）</div>}
      {err && <div className="rw-kb-err">{err}</div>}
      {['A', 'B', 'C'].map((g) => (
        <div key={g} className="rw-cap-group">
          <div className="rw-cap-gtitle">{groupNames ? groupNames[g] : ('组 ' + g)}</div>
          {caps.filter((c) => c.group === g).map((c) => (
            <label key={c.key} className="rw-cap-item">
              <input type="checkbox" checked={c.enabled} onChange={(e) => toggleCap(c.key, e.target.checked)} />
              <span>{c.name}</span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}
