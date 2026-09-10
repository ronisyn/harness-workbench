// src/console/ModelPlaza.jsx - A10 §8.2 模型广场：厂商发现/连接态 + key 临时测试 + 模型启停 + 市场拉取/接入
// + auto 全局默认模型写口（default_models，§9 登记③）+ 跨壳默认模型一览（只读，壳级唯一写点=Agent 装配向导）。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function ModelPlaza() {
  const [provs, setProvs] = useState([]);     // 全部 providers（含 models[id/enabled]）
  const [market, setMarket] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);          // 市场刷新中
  const [selModels, setSelModels] = useState({});   // 勾选接入（键带源前缀防跨源串号）
  // key 测试表单：按 provider_key 记录临时输入（不落库）
  const [testKey, setTestKey] = useState({});
  const [testing, setTesting] = useState('');
  const [testRes, setTestRes] = useState({});
  // A10 全局默认模型 + 跨壳一览
  const [dm, setDm] = useState({ defaults: {}, providers: [] });
  const [dmEdit, setDmEdit] = useState({});
  const [shellOv, setShellOv] = useState({ shells: [], globalDefaults: {} });

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([api.providers(), api.marketList()]);
      setProvs(p.providers || []);
      setMarket(m.sources || []);
    } catch (e) { setErr(e.message); }
    try { const d = await api.defaultModels(); setDm({ defaults: d.defaults || {}, providers: d.providers || [] }); setDmEdit({}); } catch { /* 忽略 */ }
    try { setShellOv(await api.shellModelOverview()); } catch { /* 忽略 */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveDefault = async (pk) => {
    const v = dmEdit[pk];
    if (v === undefined) return;
    setErr('');
    try {
      const r = await api.setDefaultModels({ [pk]: v });
      setMsg('已设置 ' + pk + ' 的全局默认模型' + (v ? '：' + v : '（清除覆盖，回落厂商默认）'));
      setDm((d) => ({ ...d, defaults: r.defaults || {} }));
      setDmEdit((o) => { const n = { ...o }; delete n[pk]; return n; });
      load();
    } catch (e) { setErr(e.message); }
  };

  const flash = async (fn, okTxt) => { try { await fn(); if (okTxt) { setMsg(okTxt); setTimeout(() => setMsg(''), 2000); } } catch { /* 错误已由调用方处理 */ } };

  const toggleModel = async (m) => {
    try { await api.modelToggle(m.id, !Boolean(m.enabled)); flash(() => load(), (m.enabled ? '已停用 ' : '已启用 ') + m.model_id); }
    catch (e) { setErr(e.message); }
  };

  const doTest = async (pk, baseUrl) => {
    const key = String(testKey[pk] || '').trim();
    if (!key) { setErr('请输入 ' + pk + ' 的 API Key（仅本次测试，不落库——§8 凭证不入 DB）'); return; }
    setTesting(pk); setErr('');
    try {
      const r = await api.providerTest(baseUrl, key);
      // ok=true：key 连通（400=探测模型名被拒但鉴权过，服务端 note 已说明）；ok=false：note 含具体原因
      setTestRes((o) => ({ ...o, [pk]: (r.ok ? '✅ ' : '❌ ') + (r.note || ('连通 (status ' + (r.status || '?') + ')')) }));
    } catch (e) { setTestRes((o) => ({ ...o, [pk]: '❌ ' + (e.note || e.message) })); }
    finally { setTesting(''); }
  };

  const refreshMarket = async () => {
    setBusy(true); setErr('');
    try { await api.marketRefresh(); await load(); setMsg('市场已刷新'); setTimeout(() => setMsg(''), 2000); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const connectMarket = async (source, modelIds) => {
    try {
      const d = await api.marketConnect(source, modelIds);
      setSelModels({});
      flash(() => load(), '已接入 ' + (d.inserted || []).length + ' 个模型（' + source + '）');
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">已登记厂商（官方预置 + 市场拉取；connected=服务端已配 Key）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      {provs.map((p) => (
        <div key={p.provider_key} className="rw-provider">
          <div className="rw-provider-name">
            {p.name}
            <span className={'rw-kb-tag ' + (p.connected ? 'global' : 'conv')}>{p.connected ? '已接入' : '未配 Key'}</span>
            <code className="rw-provider-key">{p.provider_key}</code>
            <span className="rw-provider-key">{p.base_url}</span>
          </div>
          {/* key 临时测试 */}
          <div className="rw-console-toolbar" style={{ marginTop: 6, marginBottom: 4 }}>
            <input className="rw-input" style={{ minWidth: 220 }} type="password" placeholder={p.connected ? '已配置 Key（可临时换测连通）' : '粘贴 Key 测连通（不保存）'}
              value={testKey[p.provider_key] || ''}
              onChange={(e) => setTestKey((o) => ({ ...o, [p.provider_key]: e.target.value }))} />
            <button className="rw-btn" disabled={testing === p.provider_key} onClick={() => doTest(p.provider_key, p.base_url)}>
              {testing === p.provider_key ? '测试中…' : '测试连通'}
            </button>
            {testRes[p.provider_key] && <span className="rw-dash-muted">{testRes[p.provider_key]}</span>}
          </div>
          {/* 模型启停 */}
          <div className="rw-provider-models">
            {(p.models || []).length === 0 && <span className="rw-dash-muted">（该厂商暂无已入库模型——可从下方市场快照勾选拉取）</span>}
            {(p.models || []).map((m) => (
              <label key={m.id} className={'rw-market-m' + (m.enabled ? '' : ' off')} style={{ opacity: m.enabled ? 1 : 0.5 }}>
                <input type="checkbox" checked={Boolean(m.enabled)} onChange={() => toggleModel(m)} />
                <span>{m.model_id}</span>
                {m.name && m.name !== m.model_id && <span className="rw-dash-muted">（{m.name}）</span>}
              </label>
            ))}
          </div>
        </div>
      ))}
      {provs.length === 0 && <div className="rw-console-ph"><div>暂无厂商（服务端启动时初始化）</div></div>}

      <div className="rw-cap-gtitle" style={{ marginTop: 18 }}>auto 全局默认模型（会话选"自动路由"时该厂商使用的模型；§9 登记③ 写口）</div>
      <div className="rw-dash-muted" style={{ marginBottom: 6, fontSize: 12 }}>优先级：会话显式模型（绝对锁）→ 任务档案建议 → 壳默认模型（Agent 装配向导 step4）→ 全局默认（此处）→ 厂商硬编码默认。仅可选已启用模型（防伪配置）。</div>
      <table className="rw-console-table">
        <thead><tr><th>厂商</th><th>当前全局默认</th><th>改为</th><th style={{ width: 90 }}>操作</th></tr></thead>
        <tbody>
          {(dm.providers || []).map((p) => (
            <tr key={p.key}>
              <td>{p.name} <code style={{ fontSize: 10 }}>{p.key}</code></td>
              <td>{dm.defaults[p.key] || '（未设，用厂商默认）'}</td>
              <td>
                <select className="rw-select" value={dmEdit[p.key] !== undefined ? dmEdit[p.key] : (dm.defaults[p.key] || '')}
                  onChange={(e) => setDmEdit((o) => ({ ...o, [p.key]: e.target.value }))}>
                  <option value="">（清除覆盖=用厂商默认）</option>
                  {(p.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </td>
              <td><button className="rw-btn" onClick={() => saveDefault(p.key)} disabled={dmEdit[p.key] === undefined}>保存</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="rw-cap-gtitle" style={{ marginTop: 18 }}>跨壳默认模型一览（只读：壳级 modelPolicy 唯一写点=「应用 → Agent」装配向导 step4，此处不双写）</div>
      <table className="rw-console-table">
        <thead><tr><th>壳</th><th>状态</th><th>默认模型</th><th>工具档</th><th>预算(元)</th><th>质量成本偏好</th></tr></thead>
        <tbody>
          {(shellOv.shells || []).length === 0 && <tr><td colSpan="6" className="rw-empty">暂无壳</td></tr>}
          {(shellOv.shells || []).map((s) => (
            <tr key={s.key}>
              <td><b>{s.name}</b> <code style={{ fontSize: 10 }}>{s.key}</code></td>
              <td>{s.status === 'enabled' ? '启用' : '已停用'}</td>
              <td>{s.hasDefault ? (s.defaultProvider + '/' + s.defaultModel) : '（无壳默认 → 走全局/自动）'}</td>
              <td>{s.presetBase}</td>
              <td>{s.budgetYuan || '不限'}</td>
              <td>{s.qualityCostBias == null ? '—' : s.qualityCostBias}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="rw-cap-gtitle" style={{ marginTop: 18 }}>市场拉取与接入（openrouter/dashscope/siliconflow/tokenhub）</div>
      <div className="rw-market-head" style={{ marginTop: 6 }}>
        <button className="rw-btn" onClick={refreshMarket} disabled={busy}>{busy ? '刷新中…' : '🔄 刷新市场'}</button>
        <span className="rw-market-hint">勾选快照模型 → 接入（归属该平台；已接入 ✓ 不可重复勾选）</span>
      </div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      {market.map((s) => (
        <div key={s.source} className="rw-market-src">
          <div className="rw-market-srcname">{s.source}（{s.count} 个）</div>
          <div className="rw-market-models">
            {(s.models || []).slice(0, 40).map((m) => (
              <label key={m.id} className="rw-market-m">
                {/* selModels 键带源前缀：各市场源独立勾选，避免跨源串号错源接入 */}
                <input type="checkbox" checked={Boolean(selModels[s.source + '::' + m.id])} disabled={m.connected}
                  onChange={(e) => setSelModels((o) => ({ ...o, [s.source + '::' + m.id]: e.target.checked }))} />
                <span className={m.connected ? 'conn' : ''}>{m.name || m.id}{m.connected ? ' ✓' : ''}</span>
              </label>
            ))}
            {(s.models || []).length > 40 && <span className="rw-dash-muted">…等 {(s.models || []).length} 个（展示前 40）</span>}
          </div>
          {s.models.some((m) => selModels[s.source + '::' + m.id]) && (
            <button className="rw-btn pri" style={{ marginTop: 6 }} onClick={() => connectMarket(s.source, s.models.filter((m) => selModels[s.source + '::' + m.id]).map((m) => m.id))}>接入选中模型（{s.source}）</button>
          )}
        </div>
      ))}
      {!market.length && <div className="rw-empty">点击「刷新市场」加载模型</div>}
      <div className="rw-console-note">壳默认模型分配在「应用 → Agent」装配向导 step4（本页跨壳一览为只读）；会话显式选模型=绝对锁（C4），此处启停不影响已保存的显式会话选择，只影响模型菜单。auto 全局默认写入口现已开放（校验模型归属+启用态，防伪配置）。</div>
    </div>
  );
}
