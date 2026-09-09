// src/shared/ToolsetEditor.jsx - R1 单一事实源：工具启用集（真实可勾选；平台豁免恒开不可关）
// 2026-09-09 修正：① 默认启用工具可取消（defaultOn≠豁免，仅 PLATFORM_EXEMPT 恒开）；
// ② 人读化：中文名 + 分级 + 用途(when) + 悬停示例 + 不可勾原因，替代误导性"能力开关"。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

const TIER_ORDER = ['core', 'pro', 'expert'];
const TIER_LB = {
  core: '基础工具（日常高频，默认启用，可取消）',
  pro: '专业工具（按需勾选）',
  expert: '高危/全权工具（默认关闭，谨慎开启）',
};

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
      {exempt && <em className="rw-tool-tag exempt" title="平台安全必需，恒开不可关">恒开</em>}
      {defaultOn && !t.enabled && <em className="rw-tool-tag">默认建议</em>}
      {!exempt && t.enabled && <em className="rw-tool-tag on">已启用</em>}
      {!t.enabled && !exempt && !defaultOn && <em className="rw-tool-tag off">未启用</em>}
      <span className="rw-tool-when">{t.when ? String(t.when).slice(0, 70) : ''}</span>
      {t.permission === 'full' && <em className="rw-tool-tag full">全权</em>}
    </label>
  );
}

export default function ToolsetEditor({ onToast }) {
  const [tools, setTools] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState(''); // P3-2：console 无 onToast 也可见成功反馈
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try { const d = await api.getToolset(); setTools(d.tools || []); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const tell = (m) => { if (onToast) onToast(m); else { setMsg(m); setTimeout(() => setMsg(''), 2200); } };
  const save = async (target) => {
    setBusy(true); setErr('');
    try {
      // 服务端 PUT 会过滤平台豁免项；本地立即同步最终态（豁免恒真）
      await api.setToolset(target);
      setTools((ts) => ts.map((x) => ({ ...x, enabled: x.platformExempt || target.includes(x.name) })));
      tell('工具启用集已保存（下轮生效）');
    } catch (e) { const m = '保存失败：' + (e.message || e); if (onToast) onToast(m); else setErr(m); }
    finally { setBusy(false); }
  };
  // 当前生效名列表（豁免不计入可写面）
  const curEnabled = tools.filter((x) => x.enabled && !x.platformExempt).map((x) => x.name);

  const toggle = (name, on) => {
    const next = on ? [...curEnabled.filter((n) => n !== name), name] : curEnabled.filter((n) => n !== name);
    save(next);
  };
  const selectable = tools.filter((t) => !t.platformExempt);
  const allOn = selectable.length > 0 && selectable.every((t) => t.enabled);
  const allOff = !curEnabled.length;

  return (
    <div>
      <div className="rw-cap-gtitle">工具启用集 —— 真实可配面（勾选=模型可调用；取消=对话中不可用）</div>
      <div style={{ fontSize: 12, color: 'var(--rw-muted)', marginBottom: 8, lineHeight: 1.6 }}>
        只有这里的勾选真实驱动模型工具面（历史 A/B/C「能力开关」从未接线到运行时，已移除）。
        「恒开」=平台安全必需（重载/护栏/快照/钩子）不可关；默认启用的基础工具可取消。
        悬停任意工具可看 用途/勿用于/示例。工具集在「对话页 ⚙ 时代」即已真实生效（模型看不到、也调不动未勾选工具）。
      </div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      {busy && <div className="rw-dash-muted">保存中…</div>}
      {!tools.length && !err && <div className="rw-empty">加载中…</div>}
      <div className="rw-console-toolbar">
        <button className="rw-btn" disabled={busy || allOn} onClick={() => save(selectable.map((t) => t.name))}>全选</button>
        <button className="rw-btn" disabled={busy || allOff} onClick={() => save([])}>全部取消</button>
        <span className="rw-dash-muted">已启用 {curEnabled.length} / {selectable.length} 项</span>
      </div>
      {TIER_ORDER.map((tier) => {
        const items = tools.filter((t) => t.tier === tier);
        if (!items.length) return null;
        return (
          <div key={tier} className="rw-cap-group" style={{ marginTop: 10 }}>
            <div className="rw-cap-gtitle">{TIER_LB[tier]}</div>
            <div className="rw-toolgrid">
              {items.map((t) => <ToolRow key={t.name} t={t} onToggle={toggle} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
