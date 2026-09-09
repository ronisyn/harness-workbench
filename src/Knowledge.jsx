// src/Knowledge.jsx - ④ 知识库管理面板（R4 去重：上传链+列表为唯一内容体，抽屉/embedded 只是不同外层容器）
// 上传链：选文件(xlsx/csv/txt/md/json) → base64 → /api/knowledge/import → 服务端解析按行入库；
// 附带当前账号知识列表（scope/shell 过滤 + 删除）。
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api.js';

const SCOPES = [
  { v: 'global', lb: '全局（所有会话可见）' },
  { v: 'shell', lb: '壳私有（仅所选壳的会话可见）' },
];

// 2026-09-09 文档型升级：kind 分类（fact 运行事实/进度/规范/skill/错题本，默认 fact 不改旧行为；scope 三档不变）
const KINDS = [
  { v: 'fact', lb: '运行事实' },
  { v: 'progress', lb: '进化进度' },
  { v: 'guide', lb: '平台规范' },
  { v: 'skill', lb: '技能' },
  { v: 'lesson', lb: '错题本' },
];
const KIND_STYLE = {
  fact: ['fact', '#8a6d1a'], progress: ['progress', '#2b579a'], guide: ['guide', '#2a7f62'],
  skill: ['skill', '#7a4fb2'], lesson: ['lesson', '#b02a37'],
};
const kindOf = (v) => KIND_STYLE[String(v || 'fact')] || KIND_STYLE.fact;

function useKnowledgeState() {
  const [shells, setShells] = useState([]);
  const [scope, setScope] = useState('global');
  const [shellKey, setShellKey] = useState('');
  const [upKind, setUpKind] = useState('fact');      // 上传归属分类（默认运行事实）
  const [fileName, setFileName] = useState('');
  const [fileData, setFileData] = useState('');
  const [hasHeader, setHasHeader] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false); // P3-15：加载完成前不把空态当结果
  const [fScope, setFScope] = useState('');
  const [fKind, setFKind] = useState('');           // 列表 kind Tab（''=全部）
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
      // kind 由前端分组过滤（数据≤500 行，避免切 Tab 重新请求闪空/计数错位）；scope/q 走服务端
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
      const d = await api.knowledgeImport({ name: fileName, data: fileData, scope, shellKey: scope === 'shell' ? shellKey : undefined, hasHeader, kind: upKind });
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
    shells, scope, setScope, shellKey, setShellKey, upKind, setUpKind, fileName, fileData, hasHeader, setHasHeader,
    busy, msg, err, rows, loaded, fScope, setFScope, fKind, setFKind, q, setQ, fileRef, pickFile, doImport, delRow,
  };
}

// 唯一内容体（上传链 + 列表管理）——抽屉与 embedded 共用
// 2026-09-09 UI 取长补短（参照 885 工作台知识库：卡片化/范围色标/预览截断/空态更友好）+ 文档型 kind 分组
function kbKindOf(r) {
  // 优先 kind 分类色标；无 kind 时回退标题扩展名字母
  if (r.kind && KIND_STYLE[String(r.kind)]) return { tag: KIND_STYLE[String(r.kind)][0].slice(0, 2).toUpperCase(), color: KIND_STYLE[String(r.kind)][1] };
  const t = String(r.title || '');
  const ext = (t.split('.').pop() || '').toLowerCase();
  const m = { xlsx: 'X', xls: 'X', csv: 'C', txt: 'T', md: 'M', json: 'J', pdf: 'P', docx: 'D', pptx: 'P' };
  if (m[ext]) return { tag: m[ext], color: { X: '#1e7a3c', C: '#2a7f62', T: '#8a6d1a', M: '#8a6d1a', J: '#5b6472', P: '#b02a37', D: '#2b579a' }[m[ext]] };
  return { tag: 'K', color: '#8a8f98' };
}
function KbBody() {
  const s = useKnowledgeState();
  // kind 前端分组：计数基于全量 rows；展示按 fKind 过滤（切 Tab 无网络请求、无闪空/错位）
  const counts = s.rows.reduce((o, r) => { const k = String(r.kind || 'fact'); o[k] = (o[k] || 0) + 1; o._all = (o._all || 0) + 1; return o; }, {});
  const shown = s.fKind ? s.rows.filter((r) => String(r.kind || 'fact') === s.fKind) : s.rows;
  return (
    <div className="rw-kb-content">
      {/* 上传链（工具条式：归属 + 分类 + 目标壳 + 文件 + 表头 + 导入） */}
      <div className="rw-kb-upload">
        <select className="rw-select" value={s.scope} onChange={(e) => s.setScope(e.target.value)} title="知识归属">
          {SCOPES.map((x) => <option key={x.v} value={x.v}>{x.lb}</option>)}
        </select>
        <select className="rw-select" value={s.upKind} onChange={(e) => s.setUpKind(e.target.value)} title="知识分类（文档型升级）">
          {KINDS.map((x) => <option key={x.v} value={x.v}>{x.lb}</option>)}
        </select>
        {s.scope === 'shell' && (
          <select className="rw-select" value={s.shellKey} onChange={(e) => s.setShellKey(e.target.value)} title="目标壳">
            {s.shells.length === 0 && <option value="">（无可用壳）</option>}
            {s.shells.map((x) => <option key={x.skey} value={x.skey}>{x.name}</option>)}
          </select>
        )}
        <label className="rw-kb-file">
          <input ref={s.fileRef} type="file" accept=".xlsx,.xls,.csv,.txt,.md,.json" onChange={s.pickFile} />
          {s.fileName || '选择文件（xlsx/csv 行结构化 / txt/md 分段 / json）'}
        </label>
        <label className="rw-kb-hdr"><input type="checkbox" checked={s.hasHeader} onChange={(e) => s.setHasHeader(e.target.checked)} />表头</label>
        <button className="rw-btn pri" onClick={s.doImport} disabled={s.busy || !s.fileName}>{s.busy ? '导入中…' : '⬆ 导入'}</button>
      </div>
      {s.msg && <div className="rw-kb-msg">{s.msg}</div>}
      {s.err && <div className="rw-kb-err">{s.err}</div>}

      {/* 列表管理：kind Tab（像 885 文档/技能分组）+ 范围/关键词 */}
      <div className="rw-kb-kindtabs" style={{ marginTop: 14 }}>
        <span className={'rw-kb-kind' + (s.fKind === '' ? ' on' : '')} onClick={() => s.setFKind('')}>全部 <em className="rw-kb-kindc">{counts._all || 0}</em></span>
        {KINDS.map((x) => (
          <span key={x.v} className={'rw-kb-kind' + (s.fKind === x.v ? ' on' : '')} onClick={() => s.setFKind(s.fKind === x.v ? '' : x.v)}>
            {x.lb} <em className="rw-kb-kindc">{counts[x.v] || 0}</em>
          </span>
        ))}
      </div>
      <div className="rw-kb-filters" style={{ marginTop: 8 }}>
        <select className="rw-select" value={s.fScope} onChange={(e) => s.setFScope(e.target.value)}>
          <option value="">全部范围</option>
          <option value="global">全局</option>
          <option value="shell">壳私有</option>
          <option value="conv">会话私有</option>
        </select>
        <input className="rw-input" placeholder="关键词过滤（回车查询）…" value={s.q}
          onChange={(e) => s.setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') s.loadList(); }} />
        <button className="rw-btn" onClick={s.loadList}>查询</button>
      </div>
      <div className="rw-kb-list">
        {!s.loaded && <div className="rw-kb-empty">加载中…</div>}
        {s.loaded && shown.length === 0 && <div className="rw-kb-empty">（{s.fKind ? '该分类' : '当前'}暂无条目——上传文件并选对分类；条目供 RW 会话内检索，不改变任何运行行为）</div>}
        {shown.map((r) => {
          const k = kbKindOf(r);
          const kk = kindOf(r.kind);
          const scopeLb = r.scope === 'global' ? '全局' : r.scope === 'shell' ? '壳·' + (r.shell_key || r.shell_id) : '会话';
          return (
            <div key={r.id} className="rw-kb-item">
              <span className="rw-kb-item-ico" style={{ background: k.color }}>{k.tag}</span>
              <div className="rw-kb-item-main">
                <div className="rw-kb-item-head">
                  <span className="rw-kb-kindtag" style={{ background: kk[1] + '1f', color: kk[1] }}>{kk[0]}</span>
                  <span className={'rw-kb-tag ' + (r.scope === 'global' ? 'global' : r.scope === 'shell' ? 'shell' : 'conv')}>{scopeLb}</span>
                  <b title={r.title}>{r.title}</b>
                  <button className="rw-conv-del" title="删除" onClick={() => s.delRow(r.id)}>✕</button>
                </div>
                {r.body_preview && <div className="rw-kb-body">{r.body_preview}</div>}
              </div>
            </div>
          );
        })}
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
          <span>📚 知识库（运行事实/进化进度/规范/技能/错题本 · 会话内可检索）</span>
          <button className="rw-btn" onClick={onClose} title="关闭">← 返回对话</button>
        </div>
        <div className="rw-drawer-body">{body}</div>
      </div>
    </div>
  );
}
