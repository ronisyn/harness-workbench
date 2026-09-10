// src/console/AgentBoard.jsx - 应用·Agent 页（§8.9；定版导航 code 'agent'）：壳列表/详情/新建 + 装配向导 + 页内任务模板库子区（§7.5 定案 A）+ 壳详情本壳可用应用入口
// 原 1.3 壳开发升级：pack 导入 JSON 保留为"高级"折叠区；新建/编辑走装配向导；模板库同页子区。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import AgentWizard from './AgentWizard.jsx';
import TemplateBoard from './TemplateBoard.jsx';
import AppLaunch from '../shared/AppLaunch.jsx';

export default function AgentBoard({ onGoChat }) {
  const [shells, setShells] = useState([]);
  const [detail, setDetail] = useState(null);    // 选中壳详情 {shell, tools}
  const [wiz, setWiz] = useState(null);          // 向导：null=关 | {key:'new'} | {key:'edit', shellKey, pack}
  const [showImport, setShowImport] = useState(false); // 高级：pack JSON 导入折叠
  const [packText, setPackText] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mpSel, setMpSel] = useState({});
  const [provs, setProvs] = useState([]);

  const loadShells = useCallback(async () => {
    try { const s = await api.shells(); setShells(s.shells || []); }
    catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { loadShells(); api.providers().then((p) => setProvs(p.providers || [])).catch(() => {}); }, [loadShells]);

  const openWizardNew = () => { setErr(''); setMsg(''); setWiz({ key: 'new' }); };
  const openWizardEdit = async (skey) => {
    setErr(''); setMsg('');
    try { const d = await api.shellExport(skey); setWiz({ key: 'edit', shellKey: skey, pack: d.pack }); }
    catch (e) { setErr(e.message); }
  };
  const onWizDone = () => { setWiz(null); loadShells(); };

  const showDetail = async (key) => {
    try {
      const d = await api.shellGet(key);
      const sh = d.shell;
      setDetail({ shell: sh, tools: d.tools || [] });
      const mp = sh && sh.model_policy ? ((typeof sh.model_policy === 'string') ? JSON.parse(sh.model_policy) : sh.model_policy) : null;
      if (mp && (mp.defaultProvider || mp.defaultModel)) {
        setMpSel((o) => ({ ...o, [key]: { defaultProvider: mp.defaultProvider || '', defaultModel: mp.defaultModel || '' } }));
      }
    } catch (e) { setErr(e.message); }
  };

  const doImport = async () => {
    setBusy(true); setErr('');
    try {
      const pack = JSON.parse(packText);
      const r = await api.shellImport(pack);
      setMsg('导入成功：' + r.key + '（' + r.mode + '）');
      loadShells(); showDetail(r.key);
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
      showDetail(key);
    } catch (e) { setErr(e.message); }
  };

  const mpCur = detail ? (mpSel[detail.shell.skey] || { defaultProvider: '', defaultModel: '' }) : { defaultProvider: '', defaultModel: '' };
  const mpModels = mpCur.defaultProvider ? (provs.find((p) => p.provider_key === mpCur.defaultProvider)?.models || []) : [];

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">Agent（壳）—— 一个壳 = 一个租户级独立 Agent（§8.9）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}

      {wiz && <AgentWizard initial={wiz.key === 'edit' ? wiz.pack : null} onClose={() => setWiz(null)} onDone={onWizDone} />}

      {!wiz && (
        <>
          <div className="rw-console-toolbar" style={{ marginBottom: 10 }}>
            <button className="rw-btn pri" onClick={openWizardNew}>＋ 新建 Agent（装配向导）</button>
            <button className="rw-btn" onClick={() => setShowImport((v) => !v)}>{showImport ? '收起' : '高级：导入 pack JSON'}</button>
            <span className="rw-dash-muted" style={{ marginLeft: 6 }}>壳列表（pack=文件权威、DB=运行镜像 §5.2）</span>
          </div>
          {showImport && (
            <div className="rw-provider" style={{ marginBottom: 12 }}>
              <div className="rw-cap-gtitle">导入 pack（JSON；同 key=更新）</div>
              <textarea className="rw-input" rows="9" style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} value={packText} onChange={(e) => setPackText(e.target.value)} />
              <button className="rw-btn pri" onClick={doImport} disabled={busy}>{busy ? '导入中…' : '⬆ 导入壳'}</button>
            </div>
          )}
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
                {s.skey !== 'default' && <button className="rw-btn" onClick={() => openWizardEdit(s.skey)}>装配向导（编辑）</button>}
                <button className="rw-btn" onClick={() => doExport(s.skey)}>导出 pack</button>
                {s.skey !== 'default' && <button className="rw-btn" onClick={() => doClone(s.skey)}>克隆</button>}
                {s.skey !== 'default' && s.status === 'enabled' && <button className="rw-btn" onClick={() => doDisable(s.skey)}>停用</button>}
              </div>
            </div>
          ))}

          {detail && (
            <div className="rw-provider" key={detail.shell.skey}>
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
                <span>壳默认模型（会话无显式选择时按此路由；向导 step4=唯一编辑点）</span>
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
              <div className="rw-cap-gtitle" style={{ marginTop: 10 }}>工具三态（force_on/off；schema 裁剪=会话 preset∩壳 presetBase，A2 已接线）</div>
              <div className="rw-provider-models">
                {(detail.tools || []).length === 0 && <span className="rw-dash-muted">（无 force 工具）</span>}
                {detail.tools.map((t) => (
                  <span key={t.tool_name} className={'rw-provider-model ' + (t.mode === 'force_on' ? 'on' : 'off')}>
                    {t.tool_name}：{t.mode === 'force_on' ? '强制开' : '强制关'}
                  </span>
                ))}
              </div>
              {/* 本壳可用应用（§8.2：壳内可用应用入口放 Agent 装配向导 + 壳详情；同一 AppLaunch 实现） */}
              <div className="rw-cap-gtitle" style={{ marginTop: 12 }}>本壳可用应用（启动即在本壳下开会话；应用清单=扩展中心成品资产 §8.8）</div>
              <AppLaunch onGoChat={onGoChat} shellKey={detail.shell.skey || ''} compact />
            </div>
          )}

          <div className="rw-console-note">default 壳不可停用/克隆；编辑 persona/工具面/技能/扩展建议走装配向导（step 全部字段），JSON 导入为高级通道。full 工具面/规则/渠道等在 pack 内扩展。</div>
        </>
      )}

      {/* 页内任务模板库子区（§7.5 定案 A：Agent 页子区，不占导航级） */}
      <div style={{ marginTop: 6 }}>
        <TemplateBoard />
      </div>
    </div>
  );
}
