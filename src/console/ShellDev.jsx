// src/console/ShellDev.jsx - 1.3 Agent 开发（壳，§3：pack 导入导出/克隆/停用/默认模型/三态）
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

const EMPTY_PACK = `{
  "shellPackVersion": 1,
  "key": "myagent",
  "name": "我的 Agent",
  "description": "",
  "identity": { "persona": "" },
  "domain": { "agendsText": "" },
  "modelPolicy": { "defaultProvider": "deepseek", "defaultModel": "", "allowModels": [], "budgetYuan": 0 },
  "tools": { "presetBase": "standard", "forceOn": [], "forceOff": [] }
}`;

export default function ShellDev() {
  const [shells, setShells] = useState([]);
  const [detail, setDetail] = useState(null);    // 选中壳详情 {shell, tools}
  const [packText, setPackText] = useState(EMPTY_PACK);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // 壳默认模型编辑（patch modelPolicy）
  const [mpSel, setMpSel] = useState({});         // skey → {defaultProvider, defaultModel}
  const [provs, setProvs] = useState([]);         // 厂商+模型（设默认用）

  const loadShells = useCallback(async () => {
    try { const s = await api.shells(); setShells(s.shells || []); }
    catch (e) { setErr(e.message); }
  }, []);
  const loadDetail = useCallback(async (key) => {
    try {
      const d = await api.shellGet(key);
      setDetail({ shell: d.shell, tools: d.tools || [] });
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { loadShells(); api.providers().then((p) => setProvs(p.providers || [])).catch(() => {}); }, [loadShells]);

  const showDetail = async (key) => {
    await loadDetail(key);
    const sh = shells.find((s) => s.skey === key);
    let mp = null;
    if (sh && sh.model_policy) { try { mp = typeof sh.model_policy === 'string' ? JSON.parse(sh.model_policy) : sh.model_policy; } catch { mp = null; } }
    if (mp) setMpSel((o) => ({ ...o, [key]: { defaultProvider: mp.defaultProvider || '', defaultModel: mp.defaultModel || '' } }));
  };

  const doImport = async () => {
    setBusy(true); setErr('');
    try {
      const pack = JSON.parse(packText);
      const r = await api.shellImport(pack);
      setMsg('导入成功：' + r.key + '（' + r.mode + '）');
      loadShells(); loadDetail(r.key);
    } catch (e) { setErr('导入失败：' + e.message); }
    finally { setBusy(false); }
  };

  const doExport = async (key) => {
    try {
      const d = await api.shellExport(key);
      const blob = new Blob([JSON.stringify(d.pack, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = key + '.pack.json';
      a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { setErr(e.message); }
  };

  const doClone = async (key) => {
    const nk = prompt('新壳 key（小写字母数字-）', key + '-copy');
    if (!nk) return;
    try { const r = await api.shellClone(key, nk, undefined); setMsg('克隆成功：' + r.key); loadShells(); }
    catch (e) { setErr(e.message); }
  };

  const doDisable = async (key) => {
    if (!confirm('停用壳 ' + key + '？（工具/设置保留可恢复）')) return;
    try { await api.shellDisable(key); setMsg('已停用 ' + key); loadShells(); if (detail && detail.shell.skey === key) setDetail(null); }
    catch (e) { setErr(e.message); }
  };

  const saveMp = async (key) => {
    const mp = mpSel[key] || {};
    if (!mp.defaultProvider || !mp.defaultModel) { setErr('默认模型需选厂商+模型'); return; }
    try {
      await api.shellPatch(key, { modelPolicy: { defaultProvider: mp.defaultProvider, defaultModel: mp.defaultModel } });
      setMsg('已设置 ' + key + ' 默认模型：' + mp.defaultModel);
      loadDetail(key);
    } catch (e) { setErr(e.message); }
  };

  const mpCur = detail ? (mpSel[detail.shell.skey] || { defaultProvider: '', defaultModel: '' }) : { defaultProvider: '', defaultModel: '' };
  const mpModels = mpCur.defaultProvider ? (provs.find((p) => p.provider_key === mpCur.defaultProvider)?.models || []) : [];

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">壳列表（pack=文件权威、DB=运行镜像 §3.2）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      {shells.map((s) => (
        <div key={s.skey} className="rw-provider" style={s.status !== 'enabled' ? { opacity: 0.55 } : {}}>
          <div className="rw-provider-name">
            {s.skey === 'default' ? <b>默认壳（保留中性）</b> : <b>{s.name}</b>}
            <code className="rw-provider-key">{s.skey}</code>
            <span className={'rw-kb-tag ' + (s.status === 'enabled' ? 'global' : 'conv')}>{s.status === 'enabled' ? '启用' : '已停用'}</span>
            <span className="rw-dash-muted">{String(s.description || '').slice(0, 50)}</span>
          </div>
          <div className="rw-console-toolbar" style={{ marginTop: 6 }}>
            <button className="rw-btn" onClick={() => showDetail(s.skey)}>查看/配置</button>
            <button className="rw-btn" onClick={() => doExport(s.skey)}>导出 pack</button>
            {s.skey !== 'default' && <button className="rw-btn" onClick={() => doClone(s.skey)}>克隆</button>}
            {s.skey !== 'default' && s.status === 'enabled' && <button className="rw-btn" onClick={() => doDisable(s.skey)}>停用</button>}
          </div>
        </div>
      ))}

      {/* 壳详情配置 */}
      {detail && (
        <div className="rw-provider">
          <div className="rw-cap-gtitle">配置：{detail.shell.skey}</div>
          <div className="rw-cap-item col">
            <span>描述</span>
            <input className="rw-input" defaultValue={detail.shell.description || ''}
              onBlur={(e) => api.shellPatch(detail.shell.skey, { description: e.target.value }).then(() => loadShells()).catch((x) => setErr(x.message))} />
          </div>
          {detail.shell.skey !== 'default' && (
            <div className="rw-cap-item col">
              <span>Persona（空=中性不扩展语境）</span>
              <textarea className="rw-input" rows="2" defaultValue={detail.shell.persona || ''}
                onBlur={(e) => api.shellPatch(detail.shell.skey, { persona: e.target.value }).catch((x) => setErr(x.message))} />
            </div>
          )}
          <div className="rw-cap-item col">
            <span>壳默认模型（会话无显式选择时按此路由）</span>
            <div className="rw-console-toolbar">
              <select className="rw-select" value={mpCur.defaultProvider}
                onChange={(e) => setMpSel((o) => ({ ...o, [detail.shell.skey]: { defaultProvider: e.target.value, defaultModel: '' } }))}>
                <option value="">厂商…</option>
                {provs.map((p) => <option key={p.provider_key} value={p.provider_key}>{p.name}</option>)}
              </select>
              <select className="rw-select" value={mpCur.defaultModel} style={{ minWidth: 200 }}
                onChange={(e) => setMpSel((o) => ({ ...o, [detail.shell.skey]: { ...(o[detail.shell.skey] || {}), defaultModel: e.target.value } }))}>
                <option value="">模型…</option>
                {mpModels.filter((m) => m.enabled).map((m) => <option key={m.id} value={m.model_id}>{m.model_id}</option>)}
              </select>
              <button className="rw-btn pri" onClick={() => saveMp(detail.shell.skey)} disabled={!mpCur.defaultProvider || !mpCur.defaultModel}>保存默认模型</button>
            </div>
          </div>
          <div className="rw-cap-gtitle" style={{ marginTop: 10 }}>工具三态（force_on/off；会话内工具面=preset∩force∩勾选）</div>
          <div className="rw-provider-models">
            {(detail.tools || []).length === 0 && <span className="rw-dash-muted">（无 force 工具）</span>}
            {detail.tools.map((t) => (
              <span key={t.tool_name} className={'rw-provider-model ' + (t.mode === 'force_on' ? 'on' : 'off')}>
                {t.tool_name}：{t.mode === 'force_on' ? '强制开' : '强制关'}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* import */}
      <div className="rw-cap-group">
        <div className="rw-cap-gtitle">导入 pack（JSON）</div>
        <textarea className="rw-input" rows="10" style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} value={packText} onChange={(e) => setPackText(e.target.value)} />
        <button className="rw-btn pri" onClick={doImport} disabled={busy}>{busy ? '导入中…' : '⬆ 导入壳'}</button>
      </div>
      <div className="rw-console-note">full 工具面/规则/渠道等在 pack 内扩展（见方案 §3 壳定义）；当前 UI 编辑覆盖导入 JSON 或增量改名/描述/persona/默认模型。default 壳不可停用/克隆。</div>
    </div>
  );
}
