// src/shared/ProposalsManager.jsx - R1 单一事实源：平台修订提案（列表/查看/新建）
// 对话页⚙设置→提案 与 1.5 Agent 进化（提案区）共用；数据自管（/api/proposals）。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function ProposalsManager({ onToast }) {
  const [proposals, setProposals] = useState([]);
  const [content, setContent] = useState('');
  const [propTitle, setPropTitle] = useState('');
  const [propDraft, setPropDraft] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { const p = await api.proposals(); setProposals(p.proposals || []); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const view = async (file) => {
    try { const d = await api.proposalContent(file); setContent(d.content || ''); }
    catch (e) { if (onToast) onToast(e.message); else setErr(e.message); }
  };
  const create = async () => {
    if (!propTitle.trim() || !propDraft.trim()) { setErr('标题与正文必填'); return; }
    try { await api.createProposal(propTitle, propDraft); setPropTitle(''); setPropDraft(''); if (onToast) onToast('提案已创建：' + propTitle); load(); }
    catch (e) { setErr(e.message); }
  };
  return (
    <div>
      <div className="rw-cap-gtitle">平台改动提案（P3/C5）——平台 main 合入前先写提案供审阅；业务项目不受此限</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {proposals.length ? proposals.map((p) => (
        <div key={p.file} className="rw-trace-item" style={{ cursor: 'pointer' }} onClick={() => view(p.file)}>
          <div className="rw-trace-head"><b>{p.title}</b> <span className={'rw-trace-status ' + (p.status === '待审' ? 'pending' : 'done')}>{p.status}</span></div>
          <div className="rw-trace-res">{p.file}（{p.size} 字符）</div>
        </div>
      )) : <div className="rw-empty">暂无提案（平台改动时 RW 会先写提案）</div>}
      {content && (
        <details open style={{ marginTop: 8 }}><summary>提案内容</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 240, overflow: 'auto', background: '#f6f6f6', padding: 8, borderRadius: 4 }}>{content.slice(0, 12000)}</pre>
        </details>
      )}
      <div className="rw-cap-gtitle" style={{ marginTop: 12 }}>新建提案</div>
      <input className="rw-input" style={{ marginBottom: 6 }} placeholder="标题（如：批6 增加 MCP client 框架）" value={propTitle} onChange={(e) => setPropTitle(e.target.value)} />
      <textarea className="rw-input" rows="5" placeholder="正文：背景/改动/影响/验证（可用 docs/templates/提案模板.md 结构）" value={propDraft} onChange={(e) => setPropDraft(e.target.value)} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="rw-btn" onClick={create}>提交提案（存档 proposals/）</button>
      </div>
    </div>
  );
}
