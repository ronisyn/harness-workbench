// src/Dashboard.jsx - M1 总览首页（工作台首屏；v2.12 §7.3/D4）
// 组成：迷你对话 + 数据看板 + 壳预览 + 日报/周报入口 + 待加入新模型；导航回对话页（同一会话体系两视图）
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, streamChat } from './api.js';

export default function Dashboard({ user, onGoChat, onGoConsole, onLogout }) {
  // —— 迷你对话（同一会话体系：复用最近一个会话；无则现场建，均为现有 /api/chat）——
  const [conv, setConv] = useState(null);       // 迷你对话绑定的会话
  const convRef = useRef(null);                 // 同步 ref：避免连续发送时闭包读到旧 null 重复建会话
  const [q, setQ] = useState('');
  const [mini, setMini] = useState([]);         // {role:'user'|'ai', content}
  const [miniBusy, setMiniBusy] = useState(false);
  const miniRef = useRef(null);
  const [recent, setRecent] = useState([]);     // 最近会话（跳对话页用）
  // —— 看板 ——
  const [stats, setStats] = useState(null);
  const [shells, setShells] = useState([]);
  const [kbCount, setKbCount] = useState(0);
  const [tasks, setTasks] = useState([]);
  const [prov, setProv] = useState({ connected: 0, pending: 0 });
  const [market, setMarket] = useState([]);

  const loadAll = useCallback(async () => {
    try {
      const cs = await api.conversations();
      const list = cs.conversations || [];
      setRecent(list.slice(0, 8));
      // 迷你对话绑定最近会话（没有则等首次发送时创建）
      if (list.length) setConv((c) => c || list[0].id);
    } catch { /* ignore */ }
    try { const s = await api.usageStats(); setStats(s.stats); } catch { /* ignore */ }
    try { const sh = await api.shells(); setShells((sh.shells || []).filter((x) => x.status === 'enabled')); } catch { /* ignore */ }
    try { const kb = await api.knowledgeList({}); setKbCount((kb.knowledge || []).length); } catch { /* ignore */ }
    try { const t = await api.tasks(); setTasks(t.tasks || []); } catch { /* ignore */ }
    try {
      const p = await api.providers();
      const all = p.providers || [];
      setProv({ connected: all.filter((x) => x.connected).length, pending: all.filter((x) => !x.connected).length });
    } catch { /* ignore */ }
    try { const m = await api.marketList(); setMarket(m.sources || []); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  const ensureConv = async () => {
    if (convRef.current) return convRef.current;
    // 复用最近会话（若它仍有效）；否则新建
    const cs = await api.conversations();
    const list = cs.conversations || [];
    const target = conv || list[0]?.id || null;
    let id = target;
    if (!id) {
      const d = await api.createConversation('首页速问', 'full');
      id = d.id;
    }
    convRef.current = id; setConv(id);
    return id;
  };

  const askMini = async () => {
    const text = String(q || '').trim();
    if (!text || miniBusy) return;
    setMiniBusy(true); setQ('');
    const list = [...mini, { role: 'user', content: text }];
    setMini(list);
    let convId;
    try { convId = await ensureConv(); } catch (e) { setMiniBusy(false); setMini([...list, { role: 'ai', content: '⚠ ' + e.message }]); return; }
    const tail = { role: 'ai', content: '', thinking: true };
    setMini([...list, tail]);
    const ac = new AbortController();
    miniRef.current = ac;
    let acc = '';
    // patchMiniTail 通过函数式 setMini 定位末条，避免闭包过期
    const patchMiniTail = (fn) => {
      setMini((prev) => {
        if (!prev.length) return prev;
        const arr = prev.slice();
        arr[arr.length - 1] = fn(arr[arr.length - 1]);
        return arr;
      });
    };
    try {
      await streamChat({ conversationId: convId, content: text, provider: undefined, model: undefined },
        {
          onThinking: () => patchMiniTail((x) => ({ ...x, thinking: true })),
          onDelta: (d) => { acc += d; patchMiniTail((x) => ({ ...x, content: acc, thinking: false })); },
          onDone: () => patchMiniTail((x) => ({ ...x, thinking: false })),
          onError: (m) => patchMiniTail((x) => ({ ...x, content: '⚠ ' + m, thinking: false })),
        }, ac.signal);
    } catch (e) {
      if (e.name !== 'AbortError') patchMiniTail((x) => ({ ...x, content: '⚠ ' + String(e.message || '发送失败').slice(0, 200), thinking: false }));
    } finally { setMiniBusy(false); loadAll(); }
  };

  // 日报（每日自我进化 #4 / 周报 KPI #3）
  const daily = tasks.find((t) => t.id === 4);
  const weekly = tasks.find((t) => t.id === 3);
  const marketTotal = market.reduce((s, m) => s + (Number(m.count) || 0), 0);

  return (
    <div className="rw-shell">
      <header className="rw-topbar">
        <div className="rw-logo" title="总览首页">Roni Workbench</div>
        <div className="rw-conv-title">工作台总览</div>
        <div className="rw-top-actions">
          {onGoConsole && <button className="rw-btn" onClick={() => onGoConsole()} title="统一后台（M2：八板块）">🎛 后台</button>}
          <button className="rw-btn pri" onClick={() => onGoChat()} title="进入对话页（同一会话体系）">💬 对话页</button>
          <span className="rw-user">{user.username}</span>
          <button className="rw-btn" onClick={onLogout} title="退出">↪</button>
        </div>
      </header>
      <div className="rw-dash">
        {/* 迷你对话 */}
        <section className="rw-dash-card rw-dash-mini">
          <div className="rw-dash-title">⚡ 迷你对话 <span className="rw-dash-sub">与对话页同一会话体系（现有 /api/chat）；点「对话页」可展开完整工具视图</span></div>
          <div className="rw-dash-mini-box">
            {mini.length === 0 && <div className="rw-dash-hint">从这儿快速提问，无需展开完整对话页。例：今天有哪些待办？/ 当前部署状态？</div>}
            {mini.map((m, i) => (
              <div key={i} className={'rw-dash-mini-line ' + m.role}>
                {m.role === 'user' ? '我：' : m.thinking ? '🤔 思考中…' : 'AI：'}
                {m.role === 'ai' && !m.thinking && <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>}
                {m.role === 'user' && <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>}
                {m.role === 'ai' && !m.content && !m.thinking && '（无文本输出）'}
              </div>
            ))}
          </div>
          <div className="rw-dash-mini-input">
            <input className="rw-input" placeholder={conv ? '输入问题（Enter 发送）…' : '输入问题（将新建会话）…'} value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askMini(); } }} disabled={miniBusy} />
            <button className="rw-btn pri" onClick={askMini} disabled={miniBusy || !q.trim()}>{miniBusy ? '思考中…' : '发送'}</button>
          </div>
          <div className="rw-dash-recent">
            <span className="rw-dash-recent-lb">最近会话：</span>
            {recent.length === 0 && <span className="rw-dash-recent-empty">（暂无，点「对话页」新建）</span>}
            {recent.map((c) => (
              <button key={c.id} className="rw-dash-recent-item" title={String(c.title || '')} onClick={() => onGoChat(c.id)}>
                {String(c.title || '对话').slice(0, 14)}
              </button>
            ))}
          </div>
        </section>

        <div className="rw-dash-grid">
          {/* 数据看板 */}
          <section className="rw-dash-card">
            <div className="rw-dash-title">📊 用量看板</div>
            {stats ? (
              <div className="rw-dash-nums">
                <div className="rw-dash-num"><b>{stats.rounds}</b><span>LLM 轮次</span></div>
                <div className="rw-dash-num"><b>{stats.tokensIn}</b><span>输入 tok</span></div>
                <div className="rw-dash-num"><b>{stats.tokensOut}</b><span>输出 tok</span></div>
                <div className="rw-dash-num"><b>¥{Number(stats.cost || 0).toFixed(3)}</b><span>费用</span></div>
              </div>
            ) : <div className="rw-dash-hint">加载中…</div>}
            <div className="rw-dash-foot">模型观测下钻（按模型/壳/日）随统一后台 1.2（M2）</div>
          </section>

          {/* 壳预览 */}
          <section className="rw-dash-card">
            <div className="rw-dash-title">🧩 壳预览 <span className="rw-dash-sub">已启用 {shells.length} 个</span></div>
            {shells.length === 0 && <div className="rw-dash-hint">暂无壳（default 中性壳不计）</div>}
            {shells.filter((s) => s.skey !== 'default').map((s) => (
              <div key={s.skey} className="rw-dash-row">
                <b>{s.name}</b><span className="rw-dash-key">{s.skey}</span>
                <span className="rw-dash-muted">{String(s.description || '').slice(0, 40)}</span>
              </div>
            ))}
            <div className="rw-dash-foot">知识条目 <b>{kbCount}</b> 条 · 壳管理/导入随统一后台 1.3（M2）</div>
          </section>

          {/* 日报 / 周报 */}
          <section className="rw-dash-card">
            <div className="rw-dash-title">📅 日报 / 周报 <span className="rw-dash-sub">每日自我进化 #4 · 周报 KPI #3</span></div>
            {(!daily && !weekly) && <div className="rw-dash-hint">定时任务未找到（#4 每日自我进化 / #3 周报）</div>}
            {daily && (
              <div className="rw-dash-row">
                <b>日报（#4）</b>
                <span className="rw-dash-muted">{daily.enabled ? '● 运行中 ' : '○ 暂停 '}{daily.last_run ? String(daily.last_run).slice(0, 16) : '未运行'}</span>
                {daily.last_result && <div className="rw-dash-result">{String(daily.last_result).slice(0, 140)}</div>}
              </div>
            )}
            {weekly && (
              <div className="rw-dash-row">
                <b>周报（#3 KPI）</b>
                <span className="rw-dash-muted">{weekly.enabled ? '● 运行中 ' : '○ 暂停 '}{weekly.last_run ? String(weekly.last_run).slice(0, 16) : '未运行'}</span>
                {weekly.last_result && <div className="rw-dash-result">{String(weekly.last_result).slice(0, 140)}</div>}
              </div>
            )}
            <div className="rw-dash-foot">完整结果与管理在「设置→定时任务」；信号→修订提案链路见方案 §11/D8</div>
          </section>

          {/* 待加入新模型 */}
          <section className="rw-dash-card">
            <div className="rw-dash-title">🚀 待加入新模型</div>
            <div className="rw-dash-row">
              <span>已接入厂商</span><b>{prov.connected} 家</b>
            </div>
            <div className="rw-dash-row">
              <span>可接入（未配 Key）</span><b>{prov.pending} 家</b>
            </div>
            <div className="rw-dash-row">
              <span>市场快照模型</span><b>{marketTotal} 个</b>
              <span className="rw-dash-muted">（openrouter/dashscope/siliconflow/tokenhub）</span>
            </div>
            <div className="rw-dash-foot">厂商 Key 接入与模型启停在「对话页→⚙ 设置→厂商/模型市场」</div>
          </section>
        </div>
      </div>
    </div>
  );
}
