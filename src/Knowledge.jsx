// src/Knowledge.jsx - ④ 知识库管理面板（④批次授权的前端上传入口：global / shell 目标）
// 上传链：选文件(xlsx/csv/txt/md/json) → base64 → /api/knowledge/import → 服务端解析按行入库；
// 附带当前账号知识列表（scope/shell 过滤 + 删除）。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from './api.js';

const SCOPES = [
  { v: 'global', lb: '全局（所有会话可见）' },
  { v: 'shell', lb: '壳私有（仅所选壳的会话可见）' },
];

export default function Knowledge({ onClose }) {
  const [shells, setShells] = useState([]);     // 可写壳目标（enabled 且非 default）
  const [scope, setScope] = useState('global');
  const [shellKey, setShellKey] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileData, setFileData] = useState('');
  const [hasHeader, setHasHeader] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [rows, setRows] = useState([]);         // 列表
  const [fScope, setFScope] = useState('');     // 列表过滤
  const [q, setQ] = useState('');

  const loadShells = useCallback(async () => {
    try {
      const d = await api.shells();
      const usable = (d.shells || []).filter((s) => s.status === 'enabled' && s.skey !== 'default');
      setShells(usable);
      if (usable.length && !usable.some((s) => s.skey === shellKey)) setShellKey(usable[0].skey);
    } catch { setShells([]); }
  }, [shellKey]);

  const loadList = useCallback(async () => {
    try {
      const p = {};
      if (fScope) p.scope = fScope;
      if (q.trim()) p.q = q.trim();
      const d = await api.knowledgeList(p);
      setRows(d.knowledge || []);
    } catch (e) { setErr(e.message); }
  }, [fScope, q]);

  useEffect(() => { loadShells(); }, [loadShells]);
  useEffect(() => { loadList(); }, [loadList]);

  const pickFile = (e) => {
    const f = e.target.files && e.target.files[0];
    setErr(''); setMsg('');
    if (!f) { setFileName(''); setFileData(''); return; }
    setFileName(f.name);
    const rd = new FileReader();
    rd.onload = () => setFileData(String(rd.result || '').split(',')[1] || '');
    rd.onerror = () => setErr('文件读取失败');
    rd.readAsDataURL(f);
  };

  const doImport = async () => {
    setErr(''); setMsg('');
    if (!fileName || !fileData) { setErr('请先选择文件'); return; }
    if (scope === 'shell' && !shellKey) { setErr('壳私有需要选择目标壳'); return; }
    setBusy(true);
    try {
      const d = await api.knowledgeImport({ name: fileName, data: fileData, scope, shellKey: scope === 'shell' ? shellKey : undefined, hasHeader });
      setMsg(`已导入：新增 ${d.inserted} 条 / 更新 ${d.updated} 条（共解析 ${d.total} 条）`);
      setFileName(''); setFileData('');
      if (document.getElementById('kb-file')) document.getElementById('kb-file').value = '';
      loadList();
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  const delRow = async (id) => {
    if (!confirm('删除该知识条目？')) return;
    try { await api.knowledgeDelete(id); loadList(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div className="rw-mask rw-kb-mask" onClick={onClose}>
      <div className="rw-drawer rw-kb-panel" onClick={(e) => e.stopPropagation()}>
        <div className="rw-drawer-head">
          <span>📚 知识库（④ v1）</span>
          <button className="rw-btn" onClick={onClose} title="关闭">← 返回对话</button>
        </div>
        <div className="rw-drawer-body">
          {/* 上传链 */}
          <div className="rw-cap-group">
            <div className="rw-cap-gtitle">上传 → 解析入库</div>
            <label className="rw-cap-item col">
              <span style={{ marginBottom: 4 }}>归属</span>
              <select className="rw-select" value={scope} onChange={(e) => setScope(e.target.value)}>
                {SCOPES.map((s) => <option key={s.v} value={s.v}>{s.lb}</option>)}
              </select>
            </label>
            {scope === 'shell' && (
              <label className="rw-cap-item col">
                <span style={{ marginBottom: 4 }}>目标壳（壳私有仅该壳会话可见）</span>
                <select className="rw-select" value={shellKey} onChange={(e) => setShellKey(e.target.value)}>
                  {shells.length === 0 && <option value="">（无可用壳）</option>}
                  {shells.map((s) => <option key={s.skey} value={s.skey}>{s.name}（{s.skey}）</option>)}
                </select>
              </label>
            )}
            <label className="rw-cap-item col">
              <span style={{ marginBottom: 4 }}>文件（xlsx/xls/csv 按行结构化：首列=标题、整行=内容；txt/md 按空行分段；json 数组）</span>
              <input id="kb-file" className="rw-input" type="file" accept=".xlsx,.xls,.csv,.txt,.md,.json" onChange={pickFile} />
            </label>
            <label className="rw-cap-item" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              <span>表格首行为表头（作为列名）</span>
            </label>
            <button className="rw-btn pri" onClick={doImport} disabled={busy}>{busy ? '导入中…' : '⬆ 上传并导入'}</button>
            {msg && <div className="rw-kb-msg">{msg}</div>}
            {err && <div className="rw-kb-err">{err}</div>}
          </div>
          {/* 列表管理 */}
          <div className="rw-cap-group">
            <div className="rw-cap-gtitle">知识条目</div>
            <div className="rw-kb-filters">
              <select className="rw-select" value={fScope} onChange={(e) => setFScope(e.target.value)}>
                <option value="">全部范围</option>
                <option value="global">全局</option>
                <option value="shell">壳私有</option>
                <option value="conv">会话私有</option>
              </select>
              <input className="rw-input" placeholder="关键词过滤…" value={q}
                onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadList(); }} />
              <button className="rw-btn" onClick={loadList}>查询</button>
            </div>
            <div className="rw-kb-list">
              {rows.length === 0 && <div className="rw-kb-empty">（无条目）</div>}
              {rows.map((r) => (
                <div key={r.id} className="rw-kb-item">
                  <div className="rw-kb-item-head">
                    <span className={'rw-kb-tag ' + r.scope}>
                      {r.scope === 'global' ? '全局' : r.scope === 'shell' ? '壳:' + (r.shell_key || r.shell_id) : '会话'}
                    </span>
                    <b>{r.title}</b>
                    <button className="rw-conv-del" title="删除" onClick={() => delRow(r.id)}>✕</button>
                  </div>
                  {r.body_preview && <div className="rw-kb-body">{r.body_preview}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
