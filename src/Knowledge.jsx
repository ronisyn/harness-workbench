// src/Knowledge.jsx - ④ 知识库管理面板（R4 去重：上传链+列表为唯一内容体，抽屉/embedded 只是不同外层容器）
// 上传链：选文件(xlsx/csv/txt/md/json) → base64 → /api/knowledge/import → 服务端解析按行入库；
// 附带当前账号知识列表（scope/shell 过滤 + 删除）。
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api.js';

const SCOPES = [
  { v: 'global', lb: '全局（所有会话可见）' },
  { v: 'shell', lb: '壳私有（仅所选壳的会话可见）' },
];

function useKnowledgeState() {
  const [shells, setShells] = useState([]);
  const [scope, setScope] = useState('global');
  const [shellKey, setShellKey] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileData, setFileData] = useState('');
  const [hasHeader, setHasHeader] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false); // P3-15：加载完成前不把空态当结果
  const [fScope, setFScope] = useState('');
  const [q, setQ] = useState('');
  const fileRef = useRef(null);

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
    finally { setLoaded(true); }
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
      if (fileRef.current) fileRef.current.value = ''; // P3-15：文件框清空（ref 方式，两种形态共用）
      loadList();
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };
  const delRow = async (id) => {
    if (!confirm('删除该知识条目？')) return;
    try { await api.knowledgeDelete(id); loadList(); }
    catch (e) { setErr(e.message); }
  };
  return {
    shells, scope, setScope, shellKey, setShellKey, fileName, fileData, hasHeader, setHasHeader,
    busy, msg, err, rows, loaded, fScope, setFScope, q, setQ, fileRef, pickFile, doImport, delRow,
  };
}

// 唯一内容体（上传链 + 列表管理）——抽屉与 embedded 共用
function KbBody() {
  const s = useKnowledgeState();
  return (
    <div className="rw-kb-content">
      {/* 上传链 */}
      <div className="rw-cap-group">
        <div className="rw-cap-gtitle">上传 → 解析入库（xlsx/csv 行结构化 / txt/md 分段 / json 数组）</div>
        <label className="rw-cap-item col">
          <span style={{ marginBottom: 4 }}>归属</span>
          <select className="rw-select" value={s.scope} onChange={(e) => s.setScope(e.target.value)}>
            {SCOPES.map((x) => <option key={x.v} value={x.v}>{x.lb}</option>)}
          </select>
        </label>
        {s.scope === 'shell' && (
          <label className="rw-cap-item col">
            <span style={{ marginBottom: 4 }}>目标壳（壳私有仅该壳会话可见）</span>
            <select className="rw-select" value={s.shellKey} onChange={(e) => s.setShellKey(e.target.value)}>
              {s.shells.length === 0 && <option value="">（无可用壳）</option>}
              {s.shells.map((x) => <option key={x.skey} value={x.skey}>{x.name}（{x.skey}）</option>)}
            </select>
          </label>
        )}
        <label className="rw-cap-item col">
          <span style={{ marginBottom: 4 }}>文件</span>
          <input ref={s.fileRef} className="rw-input" type="file" accept=".xlsx,.xls,.csv,.txt,.md,.json" onChange={s.pickFile} />
        </label>
        <label className="rw-cap-item" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={s.hasHeader} onChange={(e) => s.setHasHeader(e.target.checked)} />
          <span>表格首行为表头（作为列名）</span>
        </label>
        <button className="rw-btn pri" onClick={s.doImport} disabled={s.busy}>{s.busy ? '导入中…' : '⬆ 上传并导入'}</button>
        {s.msg && <div className="rw-kb-msg">{s.msg}</div>}
        {s.err && <div className="rw-kb-err">{s.err}</div>}
      </div>
      {/* 列表管理 */}
      <div className="rw-cap-group">
        <div className="rw-cap-gtitle">知识条目</div>
        <div className="rw-kb-filters">
          <select className="rw-select" value={s.fScope} onChange={(e) => s.setFScope(e.target.value)}>
            <option value="">全部范围</option>
            <option value="global">全局</option>
            <option value="shell">壳私有</option>
            <option value="conv">会话私有</option>
          </select>
          <input className="rw-input" placeholder="关键词过滤…" value={s.q}
            onChange={(e) => s.setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') s.loadList(); }} />
          <button className="rw-btn" onClick={s.loadList}>查询</button>
        </div>
        <div className="rw-kb-list">
          {!s.loaded && <div className="rw-kb-empty">加载中…</div>}
          {s.loaded && s.rows.length === 0 && <div className="rw-kb-empty">（无条目）</div>}
          {s.rows.map((r) => (
            <div key={r.id} className="rw-kb-item">
              <div className="rw-kb-item-head">
                <span className={'rw-kb-tag ' + r.scope}>
                  {r.scope === 'global' ? '全局' : r.scope === 'shell' ? '壳:' + (r.shell_key || r.shell_id) : '会话'}
                </span>
                <b>{r.title}</b>
                <button className="rw-conv-del" title="删除" onClick={() => s.delRow(r.id)}>✕</button>
              </div>
              {r.body_preview && <div className="rw-kb-body">{r.body_preview}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// R4：抽屉形态（Chat 顶栏「📚 知识」打开）与 embedded 形态（1.7 板块内嵌）仅外层容器不同
export default function Knowledge({ onClose, embedded }) {
  const body = <KbBody />;
  if (embedded) {
    return (
      <div className="rw-kb-embed">
        <div className="rw-kb-embed-body">{body}</div>
      </div>
    );
  }
  return (
    <div className="rw-mask rw-kb-mask" onClick={onClose}>
      <div className="rw-drawer rw-kb-panel" onClick={(e) => e.stopPropagation()}>
        <div className="rw-drawer-head">
          <span>📚 知识库（④ v1）</span>
          <button className="rw-btn" onClick={onClose} title="关闭">← 返回对话</button>
        </div>
        <div className="rw-drawer-body">{body}</div>
      </div>
    </div>
  );
}
