// src/shared/ToolsetEditor.jsx - R1 单一事实源：工具启用集勾选（平台豁免恒开不可关）
// 统一后台 1.4 Agent 能力 使用（原对话页⚙设置抽屉已退役）；数据自管（GET/PUT /api/toolset）。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function ToolsetEditor({ onToast }) {
  const [tools, setTools] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState(''); // P3-2：console 无 onToast 也可见成功反馈
  const load = useCallback(async () => {
    setErr('');
    try { const d = await api.getToolset(); setTools(d.tools || []); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const toggleTool = async (name, on) => {
    setErr('');
    try {
      // 启用集只含非豁免项（defaultOn=平台豁免恒开，服务端强制；计算时排除防假状态）
      const cur = tools.filter((x) => x.enabled && !x.defaultOn).map((x) => x.name);
      const next = on ? [...cur, name] : cur.filter((n) => n !== name);
      await api.setToolset(next);
      setTools((ts) => ts.map((x) => (x.name === name ? { ...x, enabled: on } : x)));
      const ok = (on ? '已启用 ' : '已停用 ') + name + '（下轮生效）';
      if (onToast) onToast(ok); else { setMsg(ok); setTimeout(() => setMsg(''), 2000); }
    } catch (e) {
      const m = '工具集保存失败：' + (e.message || e);
      if (onToast) onToast(m); else setErr(m);
    }
  };
  return (
    <div>
      <div className="rw-cap-gtitle">工具启用集（平台豁免工具恒可用不可关；会话内还受壳 preset∩force 约束）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      {!tools.length && <div className="rw-empty">加载中…</div>}
      <div className="rw-toolgrid">
        {tools.map((t) => (
          <label key={t.name} className="rw-cap-item" title={'[' + (t.tier || '') + ']' + (t.defaultOn ? ' 默认启用/平台豁免' : '')}>
            <input type="checkbox" disabled={Boolean(t.defaultOn)} checked={Boolean(t.enabled)}
              onChange={(e) => toggleTool(t.name, e.target.checked)} />
            <span>{t.name}</span>
            <em className="rw-tool-tier">{t.tier}</em>
          </label>
        ))}
      </div>
    </div>
  );
}
