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

// 任务清单卡片（F9：AI 规划多步任务时展示进度）
function PlanCard({ plan }) {
  return (
    <div className="rw-plan">
      {plan.map((p) => (
        <div key={p.index} className={'rw-plan-step' + (p.done ? ' done' : '')}>
          <span className="rw-plan-check">{p.done ? '✅' : '○'}</span>
          <span>{p.text}</span>
        </div>
      ))}
    </div>
  );
}

// 轨迹卡片（对话流内联渲染，对齐 3080 工具调用展示）
const FILE_TOOLS = ['read_file', 'write_file', 'append_file', 'edit_file', 'extract_pdf', 'extract_docx', 'extract_xlsx', 'extract_pptx', 'syntax_check', 'ocr_image', 'view_image'];
function ToolCard({ t }) {
  const [open, setOpen] = React.useState(false);
  const [fileOpen, setFileOpen] = React.useState(false);
  const [fileData, setFileData] = React.useState(null);
  const st = t.status === 'fail' ? '✕' : t.status === 'running' ? '●' : '✓';
  const argsText = typeof t.args === 'string' ? t.args : JSON.stringify(t.args);
  const resText = typeof t.result === 'string' ? t.result : JSON.stringify(t.result);
  const filePath = t.args && (typeof t.args === 'object') ? (t.args.path || t.args.file || t.args.src || null) : null;
  const canOpenFile = FILE_TOOLS.includes(t.name) && filePath && t.status === 'done';
  const openFile = async (e) => {
    e.stopPropagation();
    if (!fileOpen) {
      try {
        const d = await api.getFile(filePath);
        setFileData(d);
      } catch (ex) { setFileData({ error: ex.message }); }
    }
    setFileOpen(!fileOpen);
  };
  return (
    <div className={'rw-trace-card ' + (t.status === 'fail' ? 'fail' : '')} onClick={() => setOpen(!open)}>
      <div className="rw-trace-card-head">
        <span className={'rw-trace-badge ' + (t.status || 'done')}>{st}</span>
        <span className="rw-trace-tool">🔧 {t.name}</span>
        {t.seq ? <span className="rw-trace-seq">#{t.seq}</span> : null}
        <span className="rw-trace-ms">{(t.duration_ms || 0) / 1000 > 0 ? ((t.duration_ms || 0) / 1000).toFixed(1) + 's' : ''}</span>
        {canOpenFile && <button className="rw-trace-open" onClick={openFile} title="打开文件查看内容">📂 打开</button>}
        <span className="rw-trace-toggle">{open ? '▾' : '▸'}</span>
      </div>
      {fileOpen && fileData && (
        <div className="rw-trace-filedetail" onClick={(e) => e.stopPropagation()}>
          <div className="rw-trace-filename">{filePath}</div>
          {fileData.error
            ? <div className="rw-trace-filerr">{fileData.error}</div>
            : fileData.type === 'dir'
              ? <pre>{fileData.entries.join('\n')}</pre>
              : fileData.type === 'binary'
                ? <div>二进制文件（{(fileData.size / 1024).toFixed(1)} KB），无法文本预览</div>
                : <pre>{fileData.content}</pre>}
        </div>
      )}
      {open && (
        <div className="rw-trace-card-detail" onClick={(e) => e.stopPropagation()}>
          {argsText ? <div className="rw-trace-line"><b>参数</b><pre>{argsText.slice(0, 600)}</pre></div> : null}
          {resText ? <div className="rw-trace-line"><b>结果</b><pre>{resText.slice(0, 1200)}</pre></div> : null}
        </div>
      )}
    </div>
  );
}

const PERM_LABEL = { read: '只读', write: '读写', full: '完全', guard: '需审批' };
const GROUP_NAME = { A: '渲染能力', B: '工具能力', C: '平台能力' };

export default function Chat({ user, onLogout }) {
  const [convs, setConvs] = useState([]);
  const [cur, setCur] = useState(null);
  const [curTitle, setCurTitle] = useState('');
  const [msgs, setMsgs] = useState([]);
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState('deepseek');
  const [model, setModel] = useState('');
  const [modelList, setModelList] = useState([]);
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
  const [temperature, setTemperature] = useState(1.0);
  const [tasks, setTasks] = useState([]);
  const [newTask, setNewTask] = useState({ name: '', cron: '30 2 * * *', prompt: '' });
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
    // 已接入厂商 + 各厂商模型列表（模型下拉用）
    api.providers().then((d) => {
      const active = d.providers.filter((p) => p.provider_key !== 'openrouter');
      setProviders(active.map((p) => ({ id: p.provider_key, name: p.name })));
      setProvList(d.providers);
      if (active[0]) {
        setProvider(active[0].provider_key);
        const ms = active[0].models.filter((m) => m.enabled);
        setModelList(ms);
        setModel(ms[0]?.model_id || '');
      }
    }).catch(() => {});
  }, [loadConvs]);

  const switchProvider = (pid) => {
    setProvider(pid);
    if (pid === 'auto') { setModelList([]); setModel('__auto__'); return; }
    const p = provList.find((x) => x.provider_key === pid);
    const ms = (p?.models || []).filter((m) => m.enabled);
    setModelList(ms);
    setModel(ms[0]?.model_id || '');
  };

  const openConv = async (id) => {
    setCur(id);
    const [md, tc] = await Promise.all([api.messages(id), api.toolcalls(id).catch(() => ({ toolcalls: [] }))]);
    // 轨迹按 message_id 挂到对应 assistant 消息（历史回看）
    const byMsg = {};
    for (const t of tc.toolcalls || []) {
      const mid = t.message_id;
      if (mid) (byMsg[mid] = byMsg[mid] || []).unshift(t);
    }
    const msgsWithTraces = md.messages.map((msg) => {
      let m = msg.role === 'assistant' && byMsg[msg.id]
        ? { ...msg, traces: byMsg[msg.id].map((t) => ({ name: t.tool_name, args: t.args, result: t.result_summary, status: t.status, duration_ms: t.duration_ms, seq: 0 })) }
        : msg;
      if (msg.role === 'assistant' && msg.reasoning) m = { ...m, think: msg.reasoning }; // 历史思考过程回显
      return m;
    });
    setMsgs(msgsWithTraces);
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

  // P1-F1 对话导出（Markdown）
  const exportConv = () => {
    if (!msgs.length) { setToast('当前会话无消息'); return; }
    const body = msgs.map((m) => {
      const who = m.role === 'user' ? '**我**' : '**AI**';
      const t = (m.traces && m.traces.length ? m.traces.map((tr) => `> 🔧 ${tr.name}${tr.status === 'fail' ? ' ✕' : ''}${tr.result ? '\n> ' + String(tr.result).slice(0, 200) : ''}`).join('\n') + '\n\n' : '');
      return `## ${who}\n\n${t}${m.content || ''}\n`;
    }).join('\n---\n\n');
    const blob = new Blob(['# ' + (curTitle || '对话') + '\n\n' + body], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (curTitle || '对话') + '.md';
    a.click();
    URL.revokeObjectURL(url);
    setToast('对话已导出');
  };

  // P1-F2 快捷键：Ctrl+Enter 发送 / Ctrl+N 新对话 / Ctrl+E 导出
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); send(); }
      if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newConv(); }
      if (e.ctrlKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); exportConv(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const stopGen = () => {
    if (abortRef.current) abortRef.current.abort();
    if (cur) api.stopChat(cur).catch(() => {}); // 服务端中止 Agent 轮（不再落库）
    setBusy(false);
    setMsgs((m) => m.map((x) => ({ ...x, streaming: false })));
  };

  // F20 审批裁决：批准/拒绝 guard 会话中挂起的高风险工具
  const decideApprovalMsg = async (id, decision) => {
    setMsgs((m) => m.map((x) => ({ ...x, approvals: (x.approvals || []).map((a) => (a.id === id ? { ...a, decision } : a)) })));
    try { await api.decideApproval(id, decision); setToast(decision === 'approve' ? '✅ 已批准，继续执行' : '已拒绝该操作'); }
    catch (e) { setToast(e.message); }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || busy || !cur) return;
    setInput(''); setBusy(true);
    setMsgs((m) => [...m, { role: 'user', content }]);
    let acc = '';
    setMsgs((m) => [...m, { role: 'assistant', content: '', streaming: true, traces: [], think: '', plan: null, thinking: true, approvals: [] }]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // 轨迹辅助：按 seq 更新 running 卡片（工具完成时替换）
      const patchLast = (fn) => setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? fn(x) : x)));
      await streamChat({ conversationId: cur, content, provider, model: model || undefined },
        {
          onDelta: (delta) => {
            acc += delta;
            patchLast((x) => ({ ...x, content: acc, thinking: false }));
          },
          onThinking: () => {
            // AI 处理中（保留 thinking 指示）
          },
          onThink: (text) => {
            // 思考过程实时累积（灰色斜体区）
            patchLast((x) => ({ ...x, think: (x.think || '') + text, thinking: false }));
          },
          onToolStart: (tool) => {
            // 工具开始：追加"运行中"卡片
            patchLast((x) => ({ ...x, thinking: false, traces: [...(x.traces || []), { ...tool, status: 'running' }] }));
          },
          onToolDone: (tool) => {
            // 工具完成：按 seq 更新为完成卡片（实时刷新 ✓/结果/耗时）
            patchLast((x) => ({ ...x, traces: (x.traces || []).map((t) => (t.seq === tool.seq ? { ...tool } : t)) }));
          },
          onPlan: (plan) => {
            // 任务清单进度实时更新
            patchLast((x) => ({ ...x, plan }));
          },
          onApproval: (ap) => {
            // 审批请求：追加确认卡（guard 会话高风险工具）
            patchLast((x) => ({ ...x, approvals: [...(x.approvals || []), { id: ap.id, desc: ap.desc, decision: null }] }));
          },
          onDone: () => {
            patchLast((x) => ({ ...x, streaming: false, thinking: false }));
            setBusy(false);
            loadStats(cur);
            api.toolcalls(cur).then((d) => setToolcalls(d.toolcalls || [])).catch(() => {});
          },
          onError: (msg) => { setToast(msg); patchLast((x) => ({ ...x, streaming: false, thinking: false })); setBusy(false); },
        },
        ac.signal);
    } catch (ex) {
      if (ex.name !== 'AbortError') { setToast(ex.message); }
      setMsgs((m) => m.map((x) => ({ ...x, streaming: false, thinking: false })));
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
    api.getSettings().then((s) => { if (s.settings?.temperature !== undefined) setTemperature(Number(s.settings.temperature) || 1.0); }).catch(() => {});
    if (tab === 'providers') { const p = await api.providers(); setProvList(p.providers); }
    if (tab === 'market') await loadMarket();
    if (tab === 'trace' && cur) { const t = await api.toolcalls(cur); setToolcalls(t.toolcalls || []); }
    if (tab === 'tasks') { const t = await api.tasks(); setTasks(t.tasks || []); }
  };

  const loadTasks = async () => { try { const t = await api.tasks(); setTasks(t.tasks || []); } catch { /* ignore */ } };
  const createTask = async () => {
    try {
      await api.createTask(newTask);
      setNewTask({ name: '', cron: '30 2 * * *', prompt: '' });
      setToast('定时任务已创建');
      loadTasks();
    } catch (ex) { setToast(ex.message); }
  };
  const toggleTask = async (id, enabled) => { await api.patchTask(id, { enabled }); loadTasks(); };
  const delTask = async (id) => { if (!confirm('删除该定时任务？')) return; await api.deleteTask(id); loadTasks(); };

  const setTemp = async (v) => {
    setTemperature(v);
    try { await api.setSettings({ temperature: v }); } catch { /* ignore */ }
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
          {cur && <button className="rw-btn" onClick={exportConv} title="导出对话 (Ctrl+E)">⬇ 导出</button>}
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
            <select className="rw-select" value={provider} onChange={(e) => switchProvider(e.target.value)}>
              <option value="auto">🤖 自动路由</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="rw-select rw-model-sel" value={model} onChange={(e) => setModel(e.target.value)} title="选择模型">
              {modelList.length ? modelList.map((m) => <option key={m.model_id} value={m.model_id}>{m.name || m.model_id}</option>) : <option value="">默认</option>}
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
                    ? <>
                        {m.plan && m.plan.length > 0 && <PlanCard plan={m.plan} />}
                        {m.approvals && m.approvals.length > 0 && m.approvals.map((ap) => (
                          <div key={ap.id} className="rw-approval">
                            <div className="rw-approval-desc">{ap.desc}</div>
                            {ap.decision
                              ? <div className={'rw-approval-state ' + ap.decision}>{ap.decision === 'approve' ? '✅ 已批准' : ap.decision === 'reject' ? '⛔ 已拒绝' : '⏱ 等待超时，未执行'}</div>
                              : <div className="rw-approval-btns">
                                  <button className="rw-btn pri" onClick={() => decideApprovalMsg(ap.id, 'approve')}>批准</button>
                                  <button className="rw-btn" onClick={() => decideApprovalMsg(ap.id, 'reject')}>拒绝</button>
                                </div>}
                          </div>
                        ))}
                        {m.traces && m.traces.length > 0 && (
                          <div className="rw-msg-traces">
                            {m.traces.map((t, ti) => <ToolCard key={ti} t={t} />)}
                          </div>
                        )}
                        {m.think ? (
                          <details className="rw-think" open={m.streaming}>
                            <summary>🧠 思考过程</summary>
                            <div style={{ whiteSpace: 'pre-wrap' }}>{m.think}</div>
                          </details>
                        ) : null}
                        {m.thinking && !m.content && <div className="rw-thinking">🤔 AI 思考中…</div>}
                        {m.streaming ? <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span> : <Md text={m.content} />}
                        {m.streaming && !m.content && !m.thinking && <span className="rw-caret">▋</span>}
                      </>
                    : <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="rw-stats">
            {Object.keys(stats).length > 0 && (
              <span>{stats.rounds} 轮 · {stats.steps} 步 ｜ LLM {(stats.llmMs / 1000).toFixed(1)}s ｜ 输入 {stats.tokensIn} tok · 输出 {stats.tokensOut} tok{stats.cost ? ' ｜ ¥' + Number(stats.cost).toFixed(4) : ''}</span>
            )}
          </div>
          <div className="rw-inputbar">
            <input className="rw-input" placeholder="输入消息，Enter 发送…" value={input}
              onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(); }} disabled={busy || !cur} />
            {busy
              ? <button className="rw-btn stop" onClick={stopGen} title="停止生成">■ 停止</button>
              : <button className="rw-btn pri" onClick={send} disabled={!cur || !input.trim()}>发送</button>}
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
                <button className={'rw-dtab' + (drawerTab === 'tasks' ? ' sel' : '')} onClick={() => openDrawer('tasks')}>定时</button>
              </div>
              <button className="rw-btn" onClick={() => setDrawer(false)}>收起</button>
            </div>
            <div className="rw-drawer-body">
              {drawerTab === 'caps' && (
                <div className="rw-cap-group">
                  <div className="rw-cap-gtitle">高级参数</div>
                  <label className="rw-cap-item" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>温度</span>
                    <input type="range" min="0" max="1.5" step="0.1" value={temperature}
                      onChange={(e) => setTemp(Number(e.target.value))} style={{ flex: 1 }} />
                    <span>{temperature.toFixed(1)}</span>
                  </label>
                </div>
              )}
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

              {drawerTab === 'tasks' && (
                <div className="rw-tasks">
                  <div className="rw-cap-gtitle">定时任务（cron：分 时 日 月 周）</div>
                  <div className="rw-task-new">
                    <input className="rw-input" placeholder="任务名称" value={newTask.name} onChange={(e) => setNewTask({ ...newTask, name: e.target.value })} />
                    <input className="rw-input" placeholder="cron（如 30 2 * * * 每日2:30）" value={newTask.cron} onChange={(e) => setNewTask({ ...newTask, cron: e.target.value })} />
                    <textarea className="rw-input" rows="2" placeholder="要 AI 执行的指令…" value={newTask.prompt} onChange={(e) => setNewTask({ ...newTask, prompt: e.target.value })} />
                    <button className="rw-btn pri" onClick={createTask} disabled={!newTask.name || !newTask.prompt}>＋ 创建</button>
                  </div>
                  {tasks.map((t) => (
                    <div key={t.id} className="rw-task-item">
                      <div className="rw-task-head">
                        <b>{t.name}</b>
                        <span className={'rw-task-cron ' + (t.enabled ? 'on' : '')}>{t.enabled ? '● 运行中' : '○ 已暂停'}</span>
                      </div>
                      <div className="rw-task-meta">{t.cron} ｜ {t.provider}/{t.model}</div>
                      <div className="rw-task-prompt">{String(t.prompt).slice(0, 100)}</div>
                      {t.last_run && <div className="rw-task-last">上次：{String(t.last_run).slice(0, 16)}｜{String(t.last_result || '').slice(0, 60)}</div>}
                      <div className="rw-task-ops">
                        <button className="rw-btn" onClick={() => toggleTask(t.id, !t.enabled)}>{t.enabled ? '暂停' : '启用'}</button>
                        <button className="rw-btn" onClick={() => delTask(t.id)}>删除</button>
                      </div>
                    </div>
                  ))}
                  {!tasks.length && <div className="rw-empty">暂无定时任务</div>}
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
