// src/shared/SettingsPanel.jsx - R2 单一事实源：高级参数（温度/系统提示词/运行护栏/预算/上下文，schema 驱动）
// 统一后台「系统 → 设置」使用（原对话页⚙设置抽屉已退役；2026-09-11 A8 收窄：仅运行时参数，任务/MCP/工具规则已迁出）；数据自管（GET/PUT /api/settings）。
// 2026-09-09 UI：后台 1.8 样式优化——竖排窄行改两列卡片网格（标签+输入同行，hint 撑高防"矮长条"）。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

const GROUPS = [
  { g: 'runtime', lb: '运行护栏（0=不限；即时生效）' },
  { g: 'budget', lb: '预算' },
  { g: 'context', lb: '上下文折叠' },
  { g: 'observe', lb: '观测（不 bump 政策版本）' },
];

function NumCard({ s, v, onChange, onCommit }) {
  return (
    <div className="rw-set-card">
      <div className="rw-set-card-head">
        <span className="rw-set-card-label">{s.label}</span>
        <input className="rw-set-num" type="number" min={s.min || 0} value={v ?? s.def ?? 0}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            const raw = Number(e.target.value);
            onCommit(Number.isFinite(raw) ? Math.max(s.min || 0, raw) : (s.def ?? 0));
          }} />
      </div>
      <div className="rw-set-card-hint">{s.hint || ''}</div>
    </div>
  );
}

export default function SettingsPanel({ compact = false }) {
  const [schema, setSchema] = useState([]);
  const [sval, setSval] = useState({});
  const [extra, setExtra] = useState({ temperature: 0.4, systemPrompt: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSchema(s.schema || []);
      setSval(s.settings || {});
      if (s.settings?.temperature !== undefined) setExtra((e) => ({ ...e, temperature: Number(s.settings.temperature) }));
      if (s.settings?.systemPrompt !== undefined) setExtra((e) => ({ ...e, systemPrompt: String(s.settings.systemPrompt) }));
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setOne = async (k, v) => {
    try { await api.setSettings({ [k]: v }); setSval((o) => ({ ...o, [k]: v })); setMsg('已保存：' + k); }
    catch (e) { setErr(e.message); }
    setTimeout(() => setMsg(''), 2200);
  };
  const tempTimer = React.useRef(null);
  const setTempDebounced = (v) => {
    setExtra((o) => ({ ...o, temperature: v }));
    clearTimeout(tempTimer.current);
    tempTimer.current = setTimeout(() => setOne('temperature', v), 400);
  };

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">高级参数</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}

      {/* 温度 + 系统提示词：上下两卡片，非数字窄行 */}
      <div className="rw-set-grid">
        <div className="rw-set-card span2">
          <div className="rw-set-card-head">
            <span className="rw-set-card-label">温度（{Number(extra.temperature).toFixed(2)}；拖动/键盘均可，自动保存）</span>
          </div>
          <input type="range" min="0" max="1.5" step="0.05" value={extra.temperature}
            style={{ width: '100%', height: 18, accentColor: 'var(--rw-red)', marginTop: 4 }}
            onChange={(e) => setTempDebounced(Number(e.target.value))} />
        </div>
        <div className="rw-set-card span2">
          <div className="rw-set-card-head">
            <span className="rw-set-card-label">系统提示词（用户自定义指令；留空=不注入）</span>
          </div>
          <textarea className="rw-input" rows="3" style={{ marginTop: 6, width: '100%', boxSizing: 'border-box' }} value={extra.systemPrompt}
            onChange={(e) => setExtra((o) => ({ ...o, systemPrompt: e.target.value }))}
            onBlur={() => setOne('systemPrompt', extra.systemPrompt)} />
        </div>
      </div>

      {GROUPS.map(({ g, lb }) => {
        const items = schema.filter((s) => s.group === g);
        if (!items.length) return null;
        return (
          <div key={g} className="rw-cap-group" style={{ marginTop: 16 }}>
            <div className="rw-cap-gtitle">{lb}</div>
            <div className="rw-set-grid">
              {items.map((s) => (
                <NumCard key={s.key} s={s} v={sval[s.key]}
                  onChange={(val) => setSval((o) => ({ ...o, [s.key]: val }))}
                  onCommit={(v) => { setSval((o) => ({ ...o, [s.key]: v })); setOne(s.key, v); }} />
              ))}
            </div>
          </div>
        );
      })}
      {!compact && <div className="rw-console-note">护栏键保存即 bump policy_rev（模型最快 ~5s 感知）；其余普通参数即时生效不 bump。</div>}
    </div>
  );
}
