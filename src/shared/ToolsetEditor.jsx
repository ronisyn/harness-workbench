// src/shared/ToolsetEditor.jsx - A4 §8.5 工具集 UI v2：Tab 分组(基础/专业/权限高危+计数) + 搜索 + Tab 内全选/清空
// + 开关即时保存(防抖) + 失败行内标红回滚；平台豁免恒开锁不可关；无限高内滚（列表随页面伸展）。
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api.js';

const TIER_LB = {
  base: '基础（core，read/write）',
  pro: '专业（pro）',
  guard: '权限高危 / 全权（expert 或 permission=full）',
};

function bucketOf(t) {
  if (t.tier === 'expert' || t.permission === 'full') return 'guard';
  if (t.tier === 'pro') return 'pro';
  return 'base';
}

function ToolRow({ t, onToggle }) {
  const exempt = t.platformExempt;          // 平台恒开：不可取消
  const defaultOn = t.defaultOn && !exempt; // 默认启用（可取消）
  const title = [
    t.when && '用途：' + t.when,
    t.not && '勿用于：' + t.not,
    t.ex && '示例：' + t.ex,
  ].filter(Boolean).join('\n');
  return (
    <label className={'rw-cap-item rw-tool-row' + (t.enabled ? '' : ' off')} title={title || undefined}>
      <input type="checkbox" checked={Boolean(t.enabled)} disabled={exempt}
        onChange={(e) => onToggle(t.name, e.target.checked)} />
      <span className="rw-tool-cn">{t.cn || t.name}</span>
      <code className="rw-tool-name">{t.name}</code>
      <em className={'rw-tool-tag ' + (t.tier === 'expert' ? 'full' : '')}>{TIER_TAG[t.tier]}</em>
      {exempt && <em className="rw-tool-tag exempt" title="平台安全必需，恒开不可关">恒开</em>}
      {defaultOn && !t.enabled && <em className="rw-tool-tag">默认建议</em>}
      {!exempt && t.enabled && <em className="rw-tool-tag on">已启用</em>}
      {!t.enabled && !exempt && !defaultOn && <em className="rw-tool-tag off">未启用</em>}
      <span className="rw-tool-when">{t.when ? String(t.when).slice(0, 70) : ''}</span>
    </label>
  );
}
const TIER_TAG = { core: '基础', pro: '专业', expert: '高危' };

export default function ToolsetEditor({ onToast }) {
  const [tools, setTools] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState('base');
  const [q, setQ] = useState('');
  const [saveFailed, setSaveFailed] = useState(false); // 最近一次保存失败（回滚标志）
  const debRef = useRef(null);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    setErr('');
    try { const d = await api.getToolset(); setTools(d.tools || []); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const tell = (m) => { if (onToast) onToast(m); else { setMsg(m); setTimeout(() => setMsg(''), 2000); } };

  // 防抖保存：成功则清失败标志；失败 → 行内标红提示并回滚到服务端真实态
  const doSave = async (target) => {
    if (busyRef.current) return; // 已有提交在途：防抖后若又有新变更会再调度，避免并发写乱
    busyRef.current = true;
    try {
      await api.setToolset(target);
      setTools((ts) => ts.map((x) => ({ ...x, enabled: x.platformExempt || target.includes(x.name) })));
      setSaveFailed(false);
    } catch (e) {
      setSaveFailed(true);
      tell('保存失败，已回滚：' + (e.message || e));
      load(); // 回滚到服务端真实态
    } finally { busyRef.current = false; }
  };
  const scheduleSave = (target) => {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => { debRef.current = null; doSave(target); }, 300);
  };

  // 当前生效名列表（豁免不计入可写面）
  const curEnabled = () => tools.filter((x) => x.enabled && !x.platformExempt).map((x) => x.name);

  const toggle = (name, on) => {
    const cur = curEnabled();
    const next = on ? [...cur.filter((n) => n !== name), name] : cur.filter((n) => n !== name);
    setTools((ts) => ts.map((x) => ({ ...x, enabled: x.platformExempt || next.includes(x.name) })));
    scheduleSave(next);
  };

  const visible = tools.filter((t) => bucketOf(t) === tab && (!q || t.name.toLowerCase().includes(q.toLowerCase()) || (t.cn || '').includes(q)));
  const selectableInTab = tools.filter((t) => bucketOf(t) === tab && !t.platformExempt);
  const allOnInTab = selectableInTab.length > 0 && selectableInTab.every((t) => t.enabled);
  const anyOnInTab = selectableInTab.some((t) => t.enabled);

  return (
    <div>
      <div className="rw-cap-gtitle">工具启用集 v2（勾选=模型可调用；取消=对话中不可用；权限高危/全权默认关）</div>
      <div style={{ fontSize: 12, color: 'var(--rw-muted)', marginBottom: 8, lineHeight: 1.6 }}>
        只有这里的勾选真实驱动模型工具面。「恒开」=平台安全必需（重载/护栏/快照/钩子）；「默认建议」可关。
        开关即时生效（防抖合并保存，≤300ms 内连续点击只落一次），失败自动回滚并标红。工具不可装卸（装卸=插件/扩展中心）；
        Tab 切换拉全量前端分组，无限高内滚。使用率看板在下方（§8.5，数据=近 7/30 天 tool_calls）。
      </div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      {saveFailed && <div className="rw-kb-err" style={{ marginTop: 6 }}>⚠️ 最近一次保存失败——界面已回滚到服务端状态，请重试。</div>}
      <div className="rw-console-toolbar">
        {['base', 'pro', 'guard'].map((k) => (
          <button key={k} className={'rw-btn' + (tab === k ? ' pri' : '')} onClick={() => setTab(k)}>
            {k === 'base' ? '基础' : k === 'pro' ? '专业' : '权限高危'}（{tools.filter((t) => bucketOf(t) === k).length}）
          </button>
        ))}
        <input className="rw-input" style={{ maxWidth: 180 }} placeholder="搜索工具/中文" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="rw-btn" disabled={!selectableInTab.length || allOnInTab} onClick={() => scheduleSave([...new Set([...curEnabled(), ...selectableInTab.map((t) => t.name)])])}>本 Tab 全选</button>
        <button className="rw-btn" disabled={!anyOnInTab} onClick={() => scheduleSave(curEnabled().filter((n) => !selectableInTab.some((t) => t.name === n)))}>本 Tab 清空</button>
        <span className="rw-dash-muted">已启用 {tools.filter((t) => t.enabled && !t.platformExempt).length} / {tools.filter((t) => !t.platformExempt).length} 项</span>
      </div>
      <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>{TIER_LB[tab]}</div>
      {!tools.length && !err && <div className="rw-empty">加载中…</div>}
      <div className="rw-toolgrid">
        {tools.length > 0 && visible.length === 0 && <div className="rw-dash-muted">（无匹配工具）</div>}
        {visible.map((t) => <ToolRow key={t.name} t={t} onToggle={toggle} />)}
      </div>
    </div>
  );
}
