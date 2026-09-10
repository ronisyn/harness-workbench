// src/console/ExtCenterBoard.jsx - 应用·扩展中心（§8.8；定版导航 code 'ext'）：插件/MCP/应用 统一资产卡片墙 + 需求闭环(单一 intake) + 指标 v1 前两层
// + MCP 资产化 + 发布闸门 + 提示注入触发注（外部 MCP=不可信输入）+ 应用成品入口（AppLaunch，原「应用」板块并入）。
// 数据载体=extensions/shell_extensions/extension_demands（A0 §9.3）。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import McpManager from './McpManager.jsx';
import AppLaunch from '../shared/AppLaunch.jsx';

const TYPE_CN = { plugin: '插件', mcp: 'MCP', app: '应用' };
const STATUS_CN = { dev: '研发', test: '测试', published: '已上架', retired: '退役' };
const TYPE_COLOR = { plugin: '#1565c0', mcp: '#6a1b9a', app: '#2e7d32' };
const EMPTY_FORM = { type: 'plugin', key: '', name: '', version: '0.1.0', status: 'dev', scope: 'global', capability: '', manifestRef: '' };

export default function ExtCenterBoard({ onGoChat }) {
  const [exts, setExts] = useState([]);          // 列表（列表摘要）
  const [metrics, setMetrics] = useState([]);    // 指标 v1（按资产键）
  const [tab, setTab] = useState('all');         // all|plugin|mcp|app
  const [q, setQ] = useState('');
  const [form, setForm] = useState(null);        // 注册/编辑表单（null=关）
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [detail, setDetail] = useState(null);    // 详情 {extension, loadedShells, demands}
  const [shells, setShells] = useState([]);      // 可用壳（装载管理）
  const [shellLoad, setShellLoad] = useState({}); // 壳→该资产是否装载
  const [demand, setDemand] = useState(null);    // 提需求表单（asset 键）

  const loadAll = useCallback(async () => {
    try {
      const [e, m] = await Promise.all([api.extensions({ type: tab === 'all' ? '' : tab, q }), api.extensionMetrics({ type: tab === 'all' ? '' : tab, q })]);
      setExts(e.extensions || []);
      setMetrics((m.metrics || []).reduce((o, x) => { o[x.type + ':' + x.key] = x; return o; }, {}));
    } catch (e2) { setErr(e2.message); }
  }, [tab, q]);
  useEffect(() => { loadAll(); api.shells().then((s) => setShells((s.shells || []).filter((x) => x.status === 'enabled' && x.skey !== 'default'))).catch(() => {}); }, [loadAll]);

  const reload = async () => { try { await loadAll(); if (detail) { const d = await api.extensionGet(detail.extension.type, detail.extension.key); setDetail(d); } } catch (e) { setErr(e.message); } };

  const mOf = (x) => metrics[x.type + ':' + x.key];

  const openDetail = async (type, key) => {
    setErr(''); setMsg('');
    try {
      const d = await api.extensionGet(type, key);
      setDetail(d);
      // 初始化壳装载勾选态 = 当前已装载集合（shell_id ↔ shells.id）
      const init = {};
      for (const s of shells) init[s.skey] = (d.loadedShells || []).some((l) => l.shell_id === s.id);
      setShellLoad(init);
    }
    catch (e) { setErr(e.message); }
  };

  const saveShellLoads = async (type, key) => {
    setBusy('load'); setErr('');
    try {
      // 逐壳合并保存：PUT /api/shells/:shellKey/extensions 语义=该壳扩展「整表替换」，
      // 因此必须先读该壳现有清单，再按本次勾选增/删"本资产"，避免把该壳其它已装载资产冲掉。
      let changed = 0;
      for (const s of shells) {
        const cur = await api.shellExtensions(s.skey);
        const list = (cur.extensions || []).map((x) => ({ type: x.asset_type, key: x.asset_key }));
        const has = list.some((x) => x.type === type && x.key === key);
        const want = !!shellLoad[s.skey];
        if (want === has) continue;
        const next = want ? [...list, { type, key }] : list.filter((x) => !(x.type === type && x.key === key));
        await api.setShellExtensions(s.skey, next);
        changed++;
      }
      setMsg(changed ? ('壳装载已更新（' + changed + ' 个壳变更）') : '壳装载无变化');
      await openDetail(type, key); await reload();
    } catch (e) { setErr('保存装载失败：' + e.message); }
    finally { setBusy(''); }
  };

  const doRegister = async () => {
    if (!form.key.trim() || !form.name.trim()) { setErr('key 与 name 必填'); return; }
    setBusy('reg'); setErr('');
    try {
      const cap = form.capability.trim() ? JSON.parse(form.capability) : undefined;
      await api.extensionRegister({ type: form.type, key: form.key.trim().toLowerCase(), name: form.name, version: form.version, status: form.status, scope: form.scope, capability: cap, manifestRef: form.manifestRef.trim() });
      setMsg('已注册 ' + TYPE_CN[form.type] + ' ' + form.key + '（状态 ' + STATUS_CN[form.status] + '；发布闸门=上架需能力声明）');
      setForm(null); reload();
    } catch (e) { setErr(e.message.includes('JSON') ? 'capability 需为合法 JSON 对象' : e.message); }
    finally { setBusy(''); }
  };

  const setStatus = async (x, status) => {
    if (status === 'published' && !confirm('上架 ' + x.name + '？发布闸门：需已声明 capability/manifest。')) return;
    if (status === 'retired' && !confirm('退役资产 ' + x.name + '？装载它的壳将失去该能力，确认？')) return;
    setBusy(x.key); setErr('');
    try { await api.extensionStatus(x.type, x.key, status); setMsg('状态已改为 ' + STATUS_CN[status]); reload(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const statusBtn = (x) => (
    <span>
      {x.status === 'dev' && <button className="rw-btn" disabled={busy === x.key} onClick={() => setStatus(x, 'test')}>→测试</button>}
      {(x.status === 'dev' || x.status === 'test') && <button className="rw-btn pri" disabled={busy === x.key} onClick={() => setStatus(x, 'published')} title="发布闸门：需已声明 capability/manifest">→上架</button>}
      {x.status === 'published' && <button className="rw-btn" disabled={busy === x.key} onClick={() => setStatus(x, 'retired')}>退役</button>}
      {(x.status === 'retired' || x.status === 'test') && <button className="rw-btn" disabled={busy === x.key} onClick={() => setStatus(x, 'dev')}>回研发</button>}
    </span>
  );

  const doDemand = async () => {
    if (!demand) return;
    try {
      await api.demandCreate(demand.key, { kind: 'manual', fields: { scene: demand.scene, effect: demand.effect, shells: demand.shells, actionType: demand.actionType } });
      setMsg('需求已记录（待审→审批台统一审）；月度扩展巡检将汇总同类信号');
      setDemand(null); if (detail) openDetail(detail.extension.type, detail.extension.key);
    } catch (e) { setErr(e.message); }
  };

  const setDemandStatus = async (id, status) => {
    try { await api.demandStatus(id, status); openDetail(detail.extension.type, detail.extension.key); }
    catch (e) { setErr(e.message); }
  };

  const mcpSync = async () => {
    setBusy('mcp'); setErr(''); setMsg('');
    try { const r = await api.extensionMcpSync(); setMsg('MCP 资产化同步：' + r.synced + ' 个已配置 server 登记（' + r.items.map((x) => x.id + ':' + x.status).join(',') + '）'); reload(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const visible = exts.filter((x) => (tab === 'all' ? true : x.type === tab) && (!q || x.name.includes(q) || x.key.includes(q)));

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">扩展中心（§8.8：插件 / MCP / 应用 统一可装载资产；卡片墙 + 需求闭环 + 指标 v1 前两层）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-console-toolbar" style={{ marginBottom: 8 }}>
        {['all', 'plugin', 'mcp', 'app'].map((t) => (
          <button key={t} className={'rw-btn' + (tab === t ? ' pri' : '')} onClick={() => setTab(t)}>{t === 'all' ? '全部' : TYPE_CN[t]}</button>
        ))}
        <input className="rw-input" style={{ maxWidth: 200 }} placeholder="搜索 key/名称" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="rw-btn" onClick={() => { setErr(''); setForm({ ...EMPTY_FORM }); }}>＋ 注册资产</button>
        <button className="rw-btn" disabled={busy === 'mcp'} onClick={mcpSync} title="把 settings mcp_servers 已配置 server 登记为 MCP 资产（快照工具数/连接态）">🔄 MCP 资产化同步</button>
      </div>

      {form && (
        <div className="rw-provider" style={{ marginBottom: 12 }}>
          <div className="rw-cap-gtitle">注册资产（生命周期：研发 → 测试 → 上架 → 退役；上架需能力声明=发布闸门）</div>
          <div className="rw-console-toolbar" style={{ flexWrap: 'wrap', gap: 6 }}>
            <select className="rw-select" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
              {Object.entries(TYPE_CN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="rw-input" style={{ width: 150 }} placeholder="key（小写-）" value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} />
            <input className="rw-input" style={{ width: 160 }} placeholder="name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <input className="rw-input" style={{ width: 80 }} placeholder="版本" value={form.version} onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))} />
            <select className="rw-select" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
              {Object.entries(STATUS_CN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className="rw-select" value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}>
              <option value="global">全局</option><option value="shell">按壳</option>
            </select>
            <input className="rw-input" style={{ width: 220 }} placeholder="manifest 引用（如 shellpacks/.../manifest.json）" value={form.manifestRef} onChange={(e) => setForm((f) => ({ ...f, manifestRef: e.target.value }))} />
          </div>
          <textarea className="rw-input" rows="2" style={{ width: '100%', marginTop: 6, fontFamily: 'monospace', fontSize: 12 }} placeholder="capability JSON（能力声明，发布必需）：如 {tools:[...]} 或 {actions:[...]}" value={form.capability} onChange={(e) => setForm((f) => ({ ...f, capability: e.target.value }))} />
          <div className="rw-console-toolbar" style={{ marginTop: 6 }}>
            <button className="rw-btn pri" disabled={busy === 'reg'} onClick={doRegister}>{busy === 'reg' ? '提交中…' : '保存注册'}</button>
            <button className="rw-btn" onClick={() => setForm(null)}>取消</button>
            {form.type === 'mcp' && <span className="rw-dash-muted" style={{ fontSize: 11 }}>⚠️ MCP=外部不可信输入：提示注入防线触发条件见 §11.4（随 MCP 批评估）。</span>}
          </div>
        </div>
      )}

      <div className="rw-dash-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))' }}>
        {visible.length === 0 && <div className="rw-console-ph"><div>暂无资产（注册或 MCP 同步后出现）</div></div>}
        {visible.map((x) => {
          const m = mOf(x);
          return (
            <div key={x.type + ':' + x.key} className="rw-dash-card">
              <div className="rw-dash-title">
                <span style={{ color: TYPE_COLOR[x.type] }}>{TYPE_CN[x.type]}</span> {x.name || x.key}
                <span className="rw-kb-tag global">{STATUS_CN[x.status] || x.status}</span>
              </div>
              <div className="rw-dash-muted" style={{ fontSize: 12 }}>{String((x.capability && x.capability.summary) || (x.meta && x.meta.note) || '').slice(0, 90) || ('能力声明：' + (x.capability ? JSON.stringify(x.capability).slice(0, 80) : '（未声明）'))}</div>
              <div className="rw-provider-models" style={{ marginTop: 6 }}>
                <span className="rw-provider-model">v{x.version || '?'}</span>
                <span className="rw-provider-model" title="装载该资产的壳数">壳 {x.loadedShells}</span>
                <span className="rw-provider-model" title="待审需求">需求 {x.openDemands}</span>
                {m && m.dim && (<>
                  <span className="rw-provider-model">{m.days}d 调用 {m.calls}</span>
                  <span className="rw-provider-model" style={m.failRate > 0.2 ? { color: '#c62828' } : {}}>失败 {m.failRate * 100 | 0}%</span>
                </>)}
              </div>
              <div className="rw-console-toolbar" style={{ marginTop: 6 }}>
                <button className="rw-btn" onClick={() => openDetail(x.type, x.key)}>详情/需求</button>
                <button className="rw-btn" onClick={() => setDemand({ key: x.key, type: x.type, name: x.name || x.key, scene: '', effect: '', shells: '', actionType: '' })}>💡 提需求</button>
                {statusBtn(x)}
              </div>
            </div>
          );
        })}
      </div>

      {/* 详情：能力/版本/指标/需求流/装载壳 */}
      {detail && (
        <div className="rw-provider" style={{ marginTop: 14 }}>
          <div className="rw-dash-title">{TYPE_CN[detail.extension.type]} · {detail.extension.name}（{detail.extension.key}）<span className="rw-kb-tag global">{STATUS_CN[detail.extension.status]}</span></div>
          <div className="rw-dash-muted">版本 {detail.extension.version} · scope {detail.extension.scope} · manifest {detail.extension.manifestRef || '（无）'} · 装载 {detail.extension.loadedShells} 个壳</div>
          {detail.extension.type === 'mcp' && <div className="rw-dash-result" style={{ marginTop: 6 }}>⚠️ 提示注入触发条件：MCP=外部服务/不可信输入；接入后按不可信输入处理，纵深防线随扩展中心 MCP 批评估（§11.4）。</div>}
          {detail.extension.capability && <pre style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', background: 'var(--rw-bg)', borderRadius: 8, padding: 8 }}>capability: {JSON.stringify(detail.extension.capability, null, 2)}</pre>}
          <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>壳装载（装配向导 step6 产物；MCP 装载后按壳 schema 白名单生效）</div>
          <div className="rw-provider-models">
            {shells.length === 0 && <span className="rw-dash-muted">（无可用壳）</span>}
            {shells.map((s) => {
              const loaded = (detail.loadedShells || []).some((l) => l.shell_id === s.id);
              const st = shellLoad[s.skey] !== undefined ? shellLoad[s.skey] : loaded;
              return (
                <span key={s.skey} className={'rw-provider-model' + (st ? ' on' : '')} style={{ cursor: 'pointer' }}
                  onClick={() => setShellLoad((o) => ({ ...o, [s.skey]: !(shellLoad[s.skey] !== undefined ? shellLoad[s.skey] : loaded) }))}>
                  {s.name}（{s.skey}）{st ? '已装' : '未装'}
                </span>
              );
            })}
            <button className="rw-btn pri" disabled={busy === 'load'} onClick={() => saveShellLoads(detail.extension.type, detail.extension.key)}>{busy === 'load' ? '保存中…' : '保存装载'}</button>
            <button className="rw-btn" onClick={() => { const l = {}; for (const s of shells) l[s.skey] = (detail.loadedShells || []).some((x) => x.shell_id === s.id); setShellLoad(l); }}>重置</button>
          </div>
          <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>需求/升级流（待审→采纳→立项；驳回→记录；≥3 条同类=月度巡检标升级）</div>
          <button className="rw-btn" onClick={() => setDemand({ key: detail.extension.key, type: detail.extension.type, name: detail.extension.name, scene: '', effect: '', shells: '', actionType: '' })}>💡 提需求</button>
          <div style={{ marginTop: 6 }}>
            {(detail.demands || []).length === 0 && <div className="rw-dash-muted">（暂无需求记录）</div>}
            {(detail.demands || []).map((d) => (
              <div key={d.id} className="rw-provider" style={{ padding: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 12 }}>
                  <span className="rw-provider-model">{d.kindCn}</span>
                  <span className="rw-provider-model">来自：{d.source}</span>
                  <span className="rw-kb-tag global">{d.status}</span>
                  <span className="rw-dash-muted">#{d.id}</span>
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '4px 0' }}>{d.content}</pre>
                {d.status === '待审' && (
                  <div className="rw-console-toolbar">
                    <button className="rw-btn pri" onClick={() => setDemandStatus(d.id, '采纳')}>采纳（立项/升级）</button>
                    <button className="rw-btn" onClick={() => setDemandStatus(d.id, '驳回')}>驳回</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="rw-console-toolbar" style={{ marginTop: 8 }}>
            <button className="rw-btn" onClick={() => setDetail(null)}>← 收起</button>
            {statusBtn(detail.extension)}
          </div>
        </div>
      )}

      {/* 需求采集弹层（单一 intake：字段齐才可提交） */}
      {demand && (
        <div className="rw-provider" style={{ marginTop: 14, border: '1px solid var(--rw-yellow)' }}>
          <div className="rw-cap-gtitle">需求采集：{TYPE_CN[demand.type]}「{demand.name}」（四字段齐备才可提交 → 待审）</div>
          {['scene', 'effect', 'shells', 'actionType'].map((f) => (
            <div key={f} className="rw-cap-item col">
              <span>{f === 'scene' ? '触发场景' : f === 'effect' ? '期望效果' : f === 'shells' ? '涉及壳' : '代码动作类型'}</span>
              <input className="rw-input" value={demand[f]} onChange={(e) => setDemand((d) => ({ ...d, [f]: e.target.value }))} placeholder={f === 'shells' ? '如 code / 全部' : f === 'actionType' ? '如 新增工具 / 升级能力 / 修 bug' : ''} />
            </div>
          ))}
          <div className="rw-console-toolbar" style={{ marginTop: 6 }}>
            <button className="rw-btn pri" disabled={!(demand.scene.trim() && demand.effect.trim() && demand.shells.trim() && demand.actionType.trim())} onClick={doDemand}>提交需求</button>
            <button className="rw-btn" onClick={() => setDemand(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="rw-console-note">资产=可装载业务资产（插件=壳内能力零件 / MCP=外部服务 / 应用=壳内点开成品入口）；平台只研发+测试+上架，壳需要时在 Agent 装配向导 step6 勾选装载。发布闸门=上架需 capability/manifest 声明；指标 v1 先做 健康度(失败率/均耗时)+活跃度(调用/活跃壳) 两层（MCP 按工具前缀归集；插件/应用调用维度待 tool_calls 增 asset 留痕，后置）。月度扩展巡检=进化集定时任务（需求≥3 或故障回升 → 建议升级）。</div>

      {/* 应用（成品入口）：§8.2/§8.8——应用不单列导航，资产页内提供"点开即用"入口；壳详情另有本壳入口 */}
      <div className="rw-cap-gtitle" style={{ marginTop: 16 }}>应用（带壳身份成品入口；原「应用」板块已按 §8.2 取消导航级，能力并入本页）</div>
      <AppLaunch onGoChat={onGoChat} compact />

      {/* A8：MCP 外部服务接入（自设置页迁入，§8.10 设置收窄） */}
      <McpManager />
    </div>
  );
}
