// src/console/AgentBoard.jsx - 应用·Agent 页（§8.9；定版导航 code 'agent'）：壳列表/详情/新建 + 装配向导 + 页内任务模板库子区（§7.5 定案 A）+ 壳详情本壳可用应用入口
// 写点纪律（§8.9 定案 B / §8.2）：壳字段（身份·人格·工具面·模型策略·技能·知识范围·扩展）**唯一写点=装配向导**；
// 本页详情=只读呈现 + 跳向导（原先在详情内联改 description/persona/默认模型=第二写面，2026-09-11 导航纠正批移除）。
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

  const loadShells = useCallback(async () => {
    try { const s = await api.shells(); setShells(s.shells || []); }
    catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { loadShells(); }, [loadShells]);

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
      setDetail({ shell: d.shell, tools: d.tools || [] });
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

  const mp = detail && detail.shell.model_policy
    ? ((typeof detail.shell.model_policy === 'string') ? JSON.parse(detail.shell.model_policy) : detail.shell.model_policy)
    : null;

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">Agent —— 一个壳 = 一个租户级独立 Agent（§8.9）</div>
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
              <div className="rw-cap-gtitle">壳详情（只读）：{detail.shell.skey}</div>
              <div className="rw-dash-muted" style={{ marginBottom: 6 }}>
                壳字段全部由装配向导写入（§8.9 定案 B：模型策略唯一写点=向导 step4；身份/人格/工具面/技能/知识范围/扩展同）。
                本页只读呈现 + 「装配向导（编辑）」入口，避免同一字段两处可改。
              </div>
              <div className="rw-cap-item col">
                <span>描述</span>
                <div className="rw-dash-result">{detail.shell.description || '（空）'}</div>
              </div>
              {detail.shell.skey !== 'default' && (
                <div className="rw-cap-item col">
                  <span>Persona（空=中性不扩展语境）</span>
                  <div className="rw-dash-result" style={{ whiteSpace: 'pre-wrap' }}>{detail.shell.persona || '（空）'}</div>
                </div>
              )}
              <div className="rw-cap-item col">
                <span>壳默认模型（会话无显式选择时按此路由）</span>
                <div className="rw-dash-result">
                  {(mp && (mp.defaultProvider || mp.defaultModel))
                    ? (mp.defaultProvider + ' / ' + mp.defaultModel)
                    : '（未设 → 走全局默认/自动路由）'}
                  {' '}<span className="rw-dash-muted">改此项请点上方「装配向导（编辑）」step4</span>
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
              <div className="rw-console-toolbar" style={{ marginTop: 8 }}>
                <button className="rw-btn" onClick={() => setDetail(null)}>← 收起详情</button>
                {detail.shell.skey !== 'default' && <button className="rw-btn pri" onClick={() => openWizardEdit(detail.shell.skey)}>装配向导（编辑）</button>}
              </div>
            </div>
          )}

          <div className="rw-console-note">default 壳不可停用/克隆；壳字段（描述/persona/工具面/模型策略/技能/知识范围/扩展）统一经装配向导写入，JSON 导入为高级通道。full 工具面/规则/渠道等在 pack 内扩展。</div>
        </>
      )}

      {/* 页内任务模板库子区（§7.5 定案 A：Agent 页子区，不占导航级） */}
      <div style={{ marginTop: 6 }}>
        <TemplateBoard />
      </div>
    </div>
  );
}
