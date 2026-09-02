// src/Chat.jsx - 主对话界面：左侧会话列表 + 中间对话区 + 统计条 + 设置抽屉
import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, streamChat, getToken } from './api.js';

// Markdown 渲染（A1-A22 基础：标题/粗体/列表/表格/代码/链接/引用）
function Md({ text }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
      {text || ''}
    </ReactMarkdown>
  );
}

const PROVIDER_LABEL = {
  deepseek: 'DeepSeek', glm: 'GLM', ark: '豆包', moonshot: 'Kimi',
  dashscope: '通义', tokenhub: 'TokenHub', qianfan: '文心', minimax: 'MiniMax', siliconflow: '硅基',
};

export default function Chat({ user, onLogout }) {
  const [convs, setConvs] = useState([]);
  const [cur, setCur] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState('deepseek');
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({});
  const [drawer, setDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState('caps');
  const [caps, setCaps] = useState([]);
  const [market, setMarket] = useState([]);
  const [marketBusy, setMarketBusy] = useState(false);
  const [selModels, setSelModels] = useState({});
  const [toast, setToast] = useState('');
  const bottomRef = useRef(null);

  const loadConvs = useCallback(async () => {
    const d = await api.conversations();
    setConvs(d.conversations);
  }, []);

  const loadStats = useCallback(async (convId) => {
    try {
      const d = await api.usageStats(convId);
      setStats(d.stats);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadConvs(); api.models().then((d) => { setProviders(d.providers); if (d.providers[0]) { setProvider(d.providers[0].id); setModel(d.providers[0].defaultModel); } }).catch(() => {}); }, [loadConvs]);

  const openConv = async (id) => {
    setCur(id);
    const d = await api.messages(id);
    setMsgs(d.messages);
    loadStats(id);
  };

  const newConv = async () => {
    const d = await api.createConversation('新对话', 'full');
    await loadConvs();
    setCur(d.id);
    setMsgs([]);
    setStats({});
  };

  const delConv = async (id, e) => {
    e.stopPropagation();
    if (!confirm('删除该会话及其消息？')) return;
    await api.deleteConversation(id);
    if (cur === id) { setCur(null); setMsgs([]); setStats({}); }
    loadConvs();
  };

  const send = async () => {
    const content = input.trim();
    if (!content || busy || !cur) return;
    setInput('');
    setBusy(true);
    const userMsg = { role: 'user', content };
    setMsgs((m) => [...m, userMsg]);
    let acc = '';
    setMsgs((m) => [...m, { role: 'assistant', content: '', streaming: true }]);
    try {
      await streamChat({ conversationId: cur, content, provider, model: model || undefined },
        (delta) => {
          acc += delta;
          setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content: acc } : x)));
        },
        () => {
          setMsgs((m) => m.map((x) => ({ ...x, streaming: false })));
          setBusy(false);
          loadStats(cur);
        },
        (msg) => { setToast(msg); setBusy(false); });
    } catch (ex) { setToast(ex.message); setBusy(false); }
  };

  const openDrawer = async () => {
    setDrawer(true);
    const d = await api.capabilities();
    setCaps(d.list);
  };

  const loadMarket = async () => {
    setMarketBusy(true);
    try { const d = await api.marketList(); setMarket(d.sources); }
    catch (ex) { setToast(ex.message); }
    finally { setMarketBusy(false); }
  };

  const refreshMarket = async () => {
    setMarketBusy(true);
    try { await api.marketRefresh(); setToast('市场已刷新'); await loadMarket(); }
    catch (ex) { setToast(ex.message); setMarketBusy(false); }
  };

  const connectMarket = async (source, models) => {
    try {
      const d = await api.marketConnect(source, models);
      setToast(`已接入 ${d.inserted.length} 个模型（${d.provider}）`);
      setSelModels({});
      loadMarket();
    } catch (ex) { setToast(ex.message); }
  };

  const toggleCap = async (key, v) => {
    setCaps((c) => c.map((x) => (x.key === key ? { ...x, enabled: v } : x)));
    await api.setCapabilities({ [key]: v });
  };

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(''), 2500); return () => clearTimeout(t); }
  }, [toast]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  return (
    <div className="rw-shell">
      {/* 左：会话列表 */}
      <aside className="rw-side">
        <div className="rw-side-head">
          <span className="rw-side-title">会话</span>
          <button className="rw-btn" onClick={newConv} title="新建对话">＋ 新建</button>
        </div>
        <div className="rw-side-list">
          {convs.map((c) => (
            <div key={c.id} className={'rw-conv' + (cur === c.id ? ' sel' : '')} onClick={() => openConv(c.id)}>
              <span className="rw-conv-t">{c.title}</span>
              <button className="rw-conv-del" onClick={(e) => delConv(c.id, e)} title="删除">✕</button>
            </div>
          ))}
        </div>
        <div className="rw-side-foot">
          <div className="rw-user">{user.username} · {user.role}</div>
          <button className="rw-btn" onClick={onLogout}>退出</button>
        </div>
      </aside>

      {/* 中：对话区 */}
      <main className="rw-main">
        <div className="rw-main-head">
          <span className="rw-main-title">Roni Workbench</span>
          <div className="rw-model-row">
            <select className="rw-select" value={provider} onChange={(e) => { const p = providers.find((x) => x.id === e.target.value); setProvider(p.id); setModel(p.defaultModel); }}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="rw-select" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">默认模型</option>
              <option value={model}>{model || '默认'}</option>
            </select>
            <button className="rw-btn" onClick={openDrawer}>⚙ 设置</button>
          </div>
        </div>

        <div className="rw-msgs">
          {!cur && <div className="rw-empty">← 新建或选择左侧会话，开始对话</div>}
          {msgs.map((m, i) => (
            <div key={i} className={'rw-msg ' + (m.role === 'user' ? 'me' : 'ai') + (m.streaming ? ' stream' : '')}>
              <div className="rw-msg-role">{m.role === 'user' ? '我' : 'RW'}</div>
              <div className="rw-msg-c">
                {m.role === 'assistant' ? (
                  <>{m.streaming ? <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span> : <Md text={m.content} />}{m.streaming && <span className="rw-caret">▋</span>}</>
                ) : (
                  <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* 统计条 */}
        <div className="rw-stats">
          {Object.keys(stats).length > 0 && (
            <span>{stats.rounds} 轮 · {stats.steps} 步 ｜ LLM {(stats.llmMs / 1000).toFixed(1)}s ｜ 输入 {stats.tokensIn} tok · 输出 {stats.tokensOut} tok</span>
          )}
        </div>

        <div className="rw-inputbar">
          <input className="rw-input" placeholder="输入消息，Enter 发送…" value={input}
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(); }} disabled={busy || !cur} />
          <button className="rw-btn pri" onClick={send} disabled={busy || !cur || !input.trim()}>{busy ? '生成中…' : '发送'}</button>
        </div>
      </main>

      {/* 右：设置抽屉 */}
      {drawer && (
        <div className="rw-mask" onClick={() => setDrawer(false)}>
          <div className="rw-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="rw-drawer-head"><span>设置</span><button className="rw-btn" onClick={() => setDrawer(false)}>收起</button></div>
            <div className="rw-drawer-body">
              <div className="rw-drawer-tabs">
                <button className={'rw-dtab' + (drawerTab === 'caps' ? ' sel' : '')} onClick={() => setDrawerTab('caps')}>能力开关</button>
                <button className={'rw-dtab' + (drawerTab === 'market' ? ' sel' : '')} onClick={() => { setDrawerTab('market'); loadMarket(); }}>模型市场</button>
              </div>
              {drawerTab === 'caps' && ['A', 'B', 'C'].map((g) => (
                <div key={g} className="rw-cap-group">
                  <div className="rw-cap-gtitle">能力组 {g}</div>
                  {caps.filter((c) => c.group === g).map((c) => (
                    <label key={c.key} className="rw-cap-item">
                      <input type="checkbox" checked={c.enabled} onChange={(e) => toggleCap(c.key, e.target.checked)} />
                      <span>{c.name}</span>
                    </label>
                  ))}
                </div>
              ))}
              {drawerTab === 'market' && (
                <div className="rw-market">
                  <div className="rw-market-head">
                    <button className="rw-btn" onClick={refreshMarket} disabled={marketBusy}>{marketBusy ? '刷新中…' : '🔄 刷新市场'}</button>
                    <span className="rw-market-hint">勾选模型→接入（归属该平台）</span>
                  </div>
                  {market.map((src) => (
                    <div key={src.source} className="rw-market-src">
                      <div className="rw-market-srcname">{src.source}（{src.count} 个）</div>
                      <div className="rw-market-models">
                        {src.models.slice(0, 40).map((m) => (
                          <label key={m.id} className="rw-market-m">
                            <input type="checkbox" checked={Boolean(selModels[m.id])} disabled={m.connected}
                              onChange={(e) => setSelModels((s) => ({ ...s, [m.id]: e.target.checked }))} />
                            <span className={m.connected ? 'conn' : ''}>{m.id}{m.connected ? ' ✓' : ''}</span>
                          </label>
                        ))}
                      </div>
                      {Object.keys(selModels).filter((k) => selModels[k]).length > 0 && (
                        <button className="rw-btn pri" onClick={() => connectMarket(src.source, Object.keys(selModels).filter((k) => selModels[k]))}>接入选中模型</button>
                      )}
                    </div>
                  ))}
                  {!market.length && <div className="rw-empty">点击「刷新市场」加载模型</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="rw-toast">{toast}</div>}
    </div>
  );
}
