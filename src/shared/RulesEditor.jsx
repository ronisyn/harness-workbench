// src/shared/RulesEditor.jsx - R1 单一事实源：allow/deny 规则编辑
// 统一后台 1.4 Agent 能力 使用（原对话页⚙设置抽屉已退役）；数据自管（GET/PUT /api/access-rules）。
// 数据自管（GET/PUT /api/access-rules）。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function RulesEditor({ onToast }) {
  const [rules, setRules] = useState([]);
  const [ruleText, setRuleText] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    setErr('');
    try { const d = await api.getRules(); setRules(d.rules || []); setRuleText(''); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const saveRules = async () => {
    setErr(''); setMsg('');
    let parsed = [];
    try {
      parsed = JSON.parse(ruleText || '[]');
      if (!Array.isArray(parsed)) throw new Error('需为数组');
    } catch (e) { setErr('规则 JSON 格式错误：' + e.message); return; }
    try {
      await api.saveRules(parsed);
      setRules(parsed); setRuleText('');
      const ok = '规则已保存（下轮生效）';
      if (onToast) onToast(ok); else { setMsg(ok); setTimeout(() => setMsg(''), 2000); }
    } catch (e) {
      const m = '规则保存失败：' + (e.message || e);
      if (onToast) onToast(m); else setErr(m);
    }
  };
  return (
    <div>
      <div className="rw-cap-gtitle">allow/deny 规则层（命中 deny 拦截；命中 allow 免纪律拦截+免 guard 审批；顺序=数组序，先命中先生效）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-cap-item col">
        <span style={{ marginBottom: 4 }}>规则 JSON（[{'{'}id, pattern: 工具名正则, argPattern?: 参数JSON正则(可空), action: "allow"|"deny", why{'}'}]，留空数组=关闭）</span>
        <textarea className="rw-input" rows="8" style={{ fontFamily: 'monospace', fontSize: 12 }}
          value={ruleText !== '' ? ruleText : (rules.length ? JSON.stringify(rules, null, 2) : '[]')}
          onChange={(e) => setRuleText(e.target.value)}
          placeholder='[{"id":1,"pattern":"^run_command$","action":"deny","why":"禁跑 shell"},{"id":2,"pattern":"^reload_platform$","action":"deny","why":"禁自动重启"}]' />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="rw-btn" onClick={saveRules}>保存规则</button>
        <button className="rw-btn" onClick={() => { setRuleText('[]'); }}>清空</button>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>当前规则 {rules.length} 条；保存后下轮工具调用生效。</div>
    </div>
  );
}
