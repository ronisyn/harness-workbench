// src/Chat.jsx - 主界面（参照 3080 布局重构）
// 顶栏(logo 左上 + 对话标题 + 权限/停止) + 左栏(模型切换上方 + 会话列表 + 设置下方) + 对话区
import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, streamChat } from './api.js';

function Md({ text }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
      {text || ''}
    </ReactMarkdown>
  );
}

const PERM_LABEL = { read: '只读', write: '读写', full: '完全' };
const GROUP_NAME = { A: '渲染能力', B: '工具能力', C: '平台能力' };

export default function Chat({ user, onLogout }) {
  const [convs, setConvs] = useState([]);
  const [cur, setCur] = useState(null);
  const [curTitle, setCurTitle] = useState('');
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
  const [provList, setProvList] = useState([]);
  const [market, setMarket] = useState([]);
  const [marketBusy, setMarketBusy] = useState(false);
  const [selModels, setSelModels] = useState({});
  const [toast, setToast] = useState('');
  const [toolcalls, setToolcalls] = useState([]);
  const abortRef = useRef(null);
  const bottomRef = useRef(null);

  const loadConvs = useCallback(async () => {
    const d = await api.conversations();
    setConvs(d.conversations);
  }, []);

  const loadStats = useCallback(async (convId) => {
    try { const d = await api.usageStats(convId); setStats(d.stats); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadConvs();
    api.models().then((d) => {
      setProviders(d.providers);
      if (d.providers[0]) { setProvider(d.providers[0].id); setModel(d.providers[0].defaultModel); }
    }).catch(() => {});
    api.providers().then((d) => setProvList(d.providers)).catch(() => {});
  }, [loadConvs]);

  const openConv = async (id) => {
    setCur(id);
    const [md, tc] = await Promise.all([api.messages(id), api.toolcalls(id).catch(() => ({ toolcalls: [] }))]);
    setMsgs(md.messages);
    setToolcalls(tc.toolcalls || []);
    loadStats(id);
    const c = convs.find((x) => x.id === id);
    setCurTitle(c?.title || '对话');
  };

  const newConv = async () => {
    const d = await api.createConversation('新对话', 'full');
    await loadConvs();
    setCur(d.id); setCurTitle('新对话'); setMsgs([]); setToolcalls([]); setStats({});
  };

  const delConv = async (id, e) => {
    e.stopPropagation();
    if (!confirm('删除该会话及其消息？')) return;
    await api.deleteConversation(id);
    if (cur === id) { setCur(null); setCurTitle(''); setMsgs([]); setStats({}); }
    loadConvs();
  };

  const stopGen = () => {
    if (abortRef.current) abortRef.current.abort();
    setBusy(false);
    setMsgs((m) => m.map((x) => ({ ...x, streaming: false })));
  };

  const send = async () => {
    const content = input.trim();
    if (!content || busy || !cur) return;
    setInput(''); setBusy(true);
    setMsgs((m) => [...m, { role: 'user', content }]);
    let acc = '';
    setMsgs((m) => [...m, { role: 'assistant', content: '', streaming: true }]);
    const ac = new AbortController();
    abortRef.current = ac;
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
          api.toolcalls(cur).then((d) => setToolcalls(d.toolcalls || [])).catch(() => {});
        },
        (msg) => { setToast(msg); setMsgs((m) => m.map((x) => ({ ...x, streaming: false }))); setBusy(false); },
        ac.signal);
    } catch (ex) {
      if (ex.name !== 'AbortError') { setToast(ex.message); }
      setMsgs((m) => m.map((x) => ({ ...x, streaming: false })));
      setBusy(false);
    }
  };

  const changePermission = async (perm) => {
    await api.patchConversation(cur, { permission: perm });
    setConvs((cs) => cs.map((c) => (c.id === cur ? { ...c, permission: perm } : c)));
    setToast('权限已切换为 ' + PERM_LABEL[perm]);
  };

  const openDrawer = async (tab = 'caps') => {
    setDrawer(true); setDrawerTab(tab);
    const d = await api.capabilities();
    setCaps(d.list);
    if (tab === 'providers') { const p = await api.providers(); setProvList(p.providers); }
    if (tab === 'market') await loadMarket();
    if (tab === 'trace' && cur) { const t = await api.toolcalls(cur); setToolcalls(t.toolcalls || []); }
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
      setToast(`已接入 ${d.inserted.length} 个模型`);
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

  const curPerm = convs.find((c) => c.id === cur)?.permission || 'full';

  return (
    <div className="rw-shell">
      {/* 顶栏：logo 左上 + 对话标题 + 操作 */}
      <header className="rw-topbar">
        <div className="rw-logo" onClick={() => { setCur(null); setMsgs([]); }}>Roni Workbench</div>
        <div className="rw-conv-title">{curTitle || 'Roni Workbench'}</div>
        <div className="rw-top-actions">
          {cur && (
            <select className="rw-select" value={curPerm} onChange={(e) => changePermission(e.target.value)} title="会话权限">
              {Object.entries(PERM_LABEL).map(([k, v]) => <option key={k} value={k}>权限：{v}</option>)}
            </select>
          )}
          {busy && <button className="rw-btn stop" onClick={stopGen}>■ 停止</button>}
        </div>
      </header>

      <div className="rw-body">
        {/* 左栏 */}
        <aside className="rw-side">
          <div className="rw-side-model">
            <select className="rw-select" value={provider} onChange={(e) => { const p = providers.find((x) => x.id === e.target.value); setProvider(p?.id || e.target.value); setModel(p?.defaultModel || ''); }}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <button className="rw-btn pri rw-newbtn" onClick={newConv}>＋ 新建对话</button>
          <div className="rw-side-list">
            {convs.map((c) => (
              <div key={c.id} className={'rw-conv' + (cur === c.id ? ' sel' : '')} onClick={() => openConv(c.id)}>
                <span className="rw-conv-t">{c.title}</span>
                <span className="rw-conv-tag">{c.channel !== 'web' ? c.channel : ''}</span>
                <button className="rw-conv-del" onClick={(e) => delConv(c.id, e)} title="删除">✕</button>
              </div>
            ))}
          </div>
          <div className="rw-side-foot">
            <button className="rw-btn" onClick={() => openDrawer('caps')}>⚙ 设置</button>
            <span className="rw-user">{user.username}</span>
            <button className="rw-btn" onClick={onLogout} title="退出">↪</button>
          </div>
        </aside>

        {/* 对话区 */}
        <main className="rw-main">
          <div className="rw-msgs">
            {!cur && <div className="rw-empty">← 新建或选择左侧会话，开始对话</div>}
            {msgs.map((m, i) => (
              <div key={i} className={'rw-msg ' + (m.role === 'user' ? 'me' : 'ai') + (m.streaming ? ' stream' : '')}>
                <div className="rw-msg-role">{m.role === 'user' ? '我' : 'AI'}</div>
                <div className="rw-msg-c">
                  {m.role === 'assistant'
                    ? <>{m.streaming ? <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span> : <Md text={m.content} />}{m.streaming && <span className="rw-caret">▋</span>}</>
                    : <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="rw-stats">
            {Object.keys(stats).length > 0 && (
              <span>{stats.rounds} 轮 · {stats.steps} 步 ｜ LLM {(stats.llmMs / 1000).toFixed(1)}s ｜ 输入 {stats.tokensIn} tok · 输出 {stats.tokensOut} tok</span>
            )}
          </div>
          <div className="rw-inputbar">
            <input className="rw-input" placeholder="输入消息，Enter 发送…" value={input}
              onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(); }} disabled={busy || !cur} />
            <button className="rw-btn pri" onClick={send} disabled={busy || !cur || !input.trim()}>{busy ? '生成中' : '发送'}</button>
          </div>
        </main>
      </div>

      {/* 设置抽屉 */}
      {drawer && (
        <div className="rw-mask" onClick={() => setDrawer(false)}>
          <div className="rw-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="rw-drawer-head">
              <span>设置</span>
              <div className="rw-drawer-tabs">
                <button className={'rw-dtab' + (drawerTab === 'caps' ? ' sel' : '')} onClick={() => openDrawer('caps')}>能力</button>
                <button className={'rw-dtab' + (drawerTab === 'providers' ? ' sel' : '')} onClick={() => openDrawer('providers')}>厂商</button>
                <button className={'rw-dtab' + (drawerTab === 'market' ? ' sel' : '')} onClick={() => openDrawer('market')}>模型市场</button>
                <button className={'rw-dtab' + (drawerTab === 'trace' ? ' sel' : '')} onClick={() => openDrawer('trace')}>轨迹</button>
              </div>
              <button className="rw-btn" onClick={() => setDrawer(false)}>收起</button>
            </div>
            <div className="rw-drawer-body">
              {drawerTab === 'caps' && ['A', 'B', 'C'].map((g) => (
                <div key={g} className="rw-cap-group">
                  <div className="rw-cap-gtitle">{GROUP_NAME[g]}</div>
                  {caps.filter((c) => c.group === g).map((c) => (
                    <label key={c.key} className="rw-cap-item">
                      <input type="checkbox" checked={c.enabled} onChange={(e) => toggleCap(c.key, e.target.checked)} />
                      <span>{c.name}</span>
                    </label>
                  ))}
                </div>
              ))}

              {drawerTab === 'providers' && (
                <div className="rw-providers">
                  <div className="rw-cap-gtitle">已接入厂商（{provList.length}）</div>
                  {provList.map((p) => (
                    <div key={p.id} className="rw-provider">
                      <div className="rw-provider-name">{p.name} <span className="rw-provider-key">{p.provider_key}</span></div>
                      <div className="rw-provider-models">
                        {p.models.length ? p.models.map((m) => (
                          <span key={m.id} className="rw-provider-model">{m.model_id}{m.enabled ? '' : '（关）'}</span>
                        )) : <span className="rw-muted">未接入模型</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {drawerTab === 'market' && (
                <div className="rw-market">
                  <div className="rw-market-head">
                    <button className="rw-btn" onClick={refreshMarket} disabled={marketBusy}>{marketBusy ? '刷新中…' : '🔄 刷新市场'}</button>
                    <span className="rw-market-hint">勾选→接入（归属该平台）</span>
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

              {drawerTab === 'trace' && (
                <div className="rw-trace">
                  <div className="rw-cap-gtitle">工具调用轨迹</div>
                  {toolcalls.length ? toolcalls.map((t) => (
                    <div key={t.id} className="rw-trace-item">
                      <div className="rw-trace-head"><b>{t.tool_name}</b> <span className={'rw-trace-status ' + t.status}>{t.status}</span> {(t.duration_ms / 1000).toFixed(1)}s</div>
                      <div className="rw-trace-args">参数：{String(t.args || '').slice(0, 150)}</div>
                      <div className="rw-trace-res">结果：{String(t.result_summary || '').slice(0, 200)}</div>
                    </div>
                  )) : <div className="rw-empty">本会话暂无工具调用</div>}
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
