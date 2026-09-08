// src/console/SettingsBoard.jsx - 1.8 设置（settings schema 驱动渲染 + 护栏/预算/上下文/运行组）
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function SettingsBoard() {
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

  const groups = [
    { g: 'runtime', lb: '运行护栏（0=不限；即时生效）' },
    { g: 'budget', lb: '预算' },
    { g: 'context', lb: '上下文折叠' },
  ];

  const setOne = async (k, v) => {
    try { await api.setSettings({ [k]: v }); setSval((o) => ({ ...o, [k]: v })); setMsg('已保存：' + k); }
    catch (e) { setErr(e.message); }
    setTimeout(() => setMsg(''), 2200);
  };
  // 温度滑块即时保存 debounce（拖动高频 onChange 避免写库风暴）
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
      <div className="rw-cap-item col">
        <span style={{ marginBottom: 4 }}>温度（{extra.temperature.toFixed(2)}；拖动/键盘均可，松开即保存）</span>
        {/* width:100% 覆盖 .rw-cap-item input 15px 全局（Chat 抽屉同款 inline flex:1，此处显式撑宽——审计 P2-5） */}
        <input type="range" min="0" max="1.5" step="0.05" value={extra.temperature} style={{ width: '100%', height: 18, accentColor: 'var(--rw-red)' }}
          onChange={(e) => setTempDebounced(Number(e.target.value))} />
      </div>
      <div className="rw-cap-item col">
        <span style={{ marginBottom: 4 }}>系统提示词（用户自定义指令；留空=不注入）</span>
        <textarea className="rw-input" rows="3" value={extra.systemPrompt}
          onChange={(e) => setExtra((o) => ({ ...o, systemPrompt: e.target.value }))}
          onBlur={() => setOne('systemPrompt', extra.systemPrompt)} />
      </div>
      {groups.map(({ g, lb }) => (
        <div key={g} className="rw-cap-group">
          <div className="rw-cap-gtitle">{lb}</div>
          {schema.filter((s) => s.group === g).map((s) => (
            <div key={s.key} className="rw-cap-item col">
              <span style={{ marginBottom: 4 }}>{s.label}（{s.hint || ''}）</span>
              <input className="rw-input" type="number" min={s.min || 0} value={sval[s.key] ?? s.def ?? 0}
                onChange={(e) => setSval((o) => ({ ...o, [s.key]: e.target.value }))}
                onBlur={(e) => {
                  // 数值归一：空/非法/低于下限 → 回退默认（防 '' / '-' / 负数直接落库——审计 P2-5）
                  const raw = Number(e.target.value);
                  const v = Number.isFinite(raw) ? Math.max(s.min || 0, raw) : (s.def ?? 0);
                  setSval((o) => ({ ...o, [s.key]: v }));
                  setOne(s.key, v);
                }} />
            </div>
          ))}
        </div>
      ))}
      <div className="rw-console-note">护栏键保存即 bump policy_rev（模型最快 ~5s 感知）；其余普通参数即时生效不 bump。MCP/规则/能力等见对应板块。</div>
    </div>
  );
}
