// src/Chat.jsx - 主界面（参照 3080 布局重构）
// 顶栏(logo 左上 + 对话标题 + 权限/停止) + 左栏(模型切换上方 + 会话列表) + 对话区
// 2026-09-09 去冗余：设置入口退役——能力/工具/规则/提案/高级参数/MCP/定时/厂商/模型市场统一在「🎛 后台」（1.1/1.4/1.5/1.8），本页聚焦对话
import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, streamChat, getToken } from './api.js';
import Knowledge from './Knowledge.jsx';
import FileAttach, { uploadToServer } from './FileAttach.jsx';

// 站内下载链接渲染为「文件卡片」：/api/download/... 需要 Bearer 鉴权（token 存 localStorage），
// 若用普通 <a> 新标签页打开会 401，因此点击时走 fetch 带 Authorization → blob → 触发浏览器下载。
// （2026-09-09 会话393 开发、09-09 恢复合入）
const FILE_BADGE = {
  xlsx: ['XLSX', '#1e7a3c'], xls: ['XLS', '#1e7a3c'],
  pdf: ['PDF', '#b02a37'], docx: ['DOC', '#2b579a'], doc: ['DOC', '#2b579a'],
  csv: ['CSV', '#2a7f62'], pptx: ['PPT', '#c55a11'], ppt: ['PPT', '#c55a11'],
  png: ['PNG', '#7a4fb2'], jpg: ['JPG', '#7a4fb2'], jpeg: ['JPG', '#7a4fb2'], gif: ['GIF', '#7a4fb2'],
  txt: ['TXT', '#8a6d1a'], md: ['MD', '#8a6d1a'], zip: ['ZIP', '#5b6472'], json: ['JSON', '#5b6472'],
};
function fileKindOf(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  const b = FILE_BADGE[ext];
  return b ? { tag: b[0], color: b[1] } : { tag: (ext || 'FILE').slice(0, 4).toUpperCase(), color: '#8a8f98' };
}
function FileLink({ href, label }) {
  const [state, setState] = useState(0); // 0=待命 busy=下载中 err=失败
  const rawName = String(href || '').split('/api/download/')[1] || '';
  let name = label;
  try { if (!name) name = decodeURIComponent(rawName); } catch { name = rawName; }
  const kind = fileKindOf(name);
  async function go(e) {
    e.preventDefault(); e.stopPropagation();
    if (state === 'busy') return;
    setState('busy');
    try {
      const tok = getToken();
      const res = await fetch(href, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setState(0);
    } catch (e) { setState('err'); }
  }
  return (
    <a className={'rw-filecard' + (state === 'err' ? ' err' : '') + (state === 'busy' ? ' busy' : '')}
      href={href} onClick={go} title={'点击下载：' + name}>
      <span className="rw-fileico" style={{ background: kind.color }}>{kind.tag}</span>
      <span className="rw-fileinfo">
        <span className="rw-filename">{name}</span>
        <span className="rw-filesub">
          {state === 'err' ? '⚠️ 下载失败（登录态失效，请刷新页面重试）' : state === 'busy' ? '⏳ 正在下载…' : '📥 点击下载文件'}
        </span>
      </span>
    </a>
  );
}

function Md({ text }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node, href, children, ...props }) => {
          const h = String(href || '');
          if (h.includes('/api/download/')) {
            const label = React.Children.toArray(children).map((c) => (typeof c === 'string' ? c : '')).join('').trim() || null;
            return <FileLink href={h} label={label} />;
          }
          return <a href={h} target="_blank" rel="noreferrer" {...props}>{children}</a>;
        },
      }}>
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

// 轨迹渲染（3080 式）：连续相同的工具合并为一行「name ×N」，行内只给最重要的信息
// （状态 + 名称 + 次数 + 末次结果一行预览 + 耗时），点击行才展开完整参数/结果；文件工具可打开
const FILE_TOOLS = ['read_file', 'write_file', 'append_file', 'edit_file', 'extract_pdf', 'extract_docx', 'extract_xlsx', 'extract_pptx', 'syntax_check', 'ocr_image', 'view_image'];
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// args/result 可能是对象/JSON 字符串——统一解析兜底（避免 "[object Object]"）
const safeJson = (v, fb) => {
  if (v == null) return fb !== undefined ? fb : {};
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};
// P2 UI diff 视图：结果文本含 diff 特征（转义 \n 的 -/+ 行 或 "diff" 字段）→ 渲染着色 diff 块
const isDiffLike = (v) => /\\n[+-] /.test(String(v ?? '')) || /"diff"\s*:/.test(String(v ?? ''));
function DiffBlock({ text }) {
  const pretty = String(text ?? '').replace(/\\n/g, '\n');
  const lines = pretty.split('\n').slice(0, 150);
  return (
    <pre className="rw-diff">
      {lines.map((ln, i) => {
        const del = /^-(?![-\s])/.test(ln) || /^-\s/.test(ln);
        const add = /^\+(?!\+)/.test(ln);
        const cls = del ? ' del' : add ? ' add' : '';
        return <div key={i} className={'rw-diff-l' + cls}>{ln || '\u00A0'}</div>;
      })}
    </pre>
  );
}

function TraceCard({ items }) {
  const [open, setOpen] = React.useState(false);
  const [fileOpen, setFileOpen] = React.useState(false);
  const [fileData, setFileData] = React.useState(null);
  const list = Array.isArray(items) ? items : [items];
  const t = list[list.length - 1]; // 以末次为准（状态/结果/耗时）
  const st = t.status === 'fail' ? '✕' : t.status === 'running' ? '●' : '✓';
  const lastDone = [...list].reverse().find((x) => x.status === 'done');
  const resText = (lastDone ? (typeof lastDone.result === 'string' ? lastDone.result : JSON.stringify(lastDone.result)) : '');
  const fileItem = [...list].reverse().find((x) => FILE_TOOLS.includes(x.name) && x.args && (typeof x.args === 'object') && (x.args.path || x.args.file || x.args.src) && x.status === 'done');
  const filePath = fileItem ? (fileItem.args.path || fileItem.args.file || fileItem.args.src) : null;
  const totalMs = list.reduce((s, x) => s + (x.duration_ms || 0), 0);
  const openFile = async (e) => {
    e.stopPropagation();
    if (!fileOpen) {
      try { const d = await api.getFile(filePath); setFileData(d); }
      catch (ex) { setFileData({ error: ex.message }); }
    }
    setFileOpen(!fileOpen);
  };
  return (
    <div className={'rw-trace-row' + (t.status === 'fail' ? ' fail' : '')}>
      <div className="rw-trace-row-head" onClick={() => setOpen(!open)}>
        <span className={'rw-trace-badge ' + (t.status || 'done')}>{st}</span>
        <span className="rw-trace-tool">{humanTool(t.name)}</span>
        {list.length > 1 && <span className="rw-trace-count">×{list.length}</span>}
        <span className="rw-trace-preview">{humanTarget(t) || oneLine(resText).slice(0, 70) || (t.status === 'running' ? '运行中…' : t.status === 'fail' ? '失败' : '')}</span>
        <span className="rw-trace-ms">{totalMs / 1000 > 0 ? ((totalMs / 1000)).toFixed(1) + 's' : ''}</span>
        {filePath && <button className="rw-trace-open" onClick={openFile} title="打开文件查看内容">📂 打开</button>}
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
        <div className="rw-trace-detail" onClick={(e) => e.stopPropagation()}>
          {list.map((x, xi) => {
            const argsText = typeof x.args === 'string' ? x.args : JSON.stringify(x.args);
            const xres = typeof x.result === 'string' ? x.result : JSON.stringify(x.result);
            return (
              <div key={xi} className={'rw-trace-step' + (x.status === 'fail' ? ' fail' : '')}>
                <div className="rw-trace-step-head">{list.length > 1 ? '#' + (xi + 1) + ' ' : ''}{x.name} · {x.status === 'done' ? '✓' : x.status === 'running' ? '● 运行中' : '✕'} {x.duration_ms ? ((x.duration_ms / 1000).toFixed(1) + 's') : ''}</div>
                {argsText ? <div className="rw-trace-line"><b>参数</b><pre>{argsText.slice(0, 500)}</pre></div> : null}
                {xres ? (isDiffLike(xres)
                  ? <div className="rw-trace-line"><b>结果（diff）</b><DiffBlock text={xres} /></div>
                  : <div className="rw-trace-line"><b>结果</b><pre>{xres.slice(0, 1000)}</pre></div>) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// 连续相同工具合并成组（同一行 ×N）；不同工具各自成行
function groupTraces(traces) {
  const out = [];
  for (const t of traces || []) {
    const last = out[out.length - 1];
    if (last && last.name === t.name && t.status !== 'running') last.items.push(t);
    else out.push({ name: t.name, items: [t] });
  }
  return out;
}

const PERM_LABEL = { read: '只读', write: '读写', full: '完全', guard: '需审批' };
const PRESET_LABEL = { all: '全量', standard: '标准', minimal: '精简' };
const PRESET_TIP = { all: '暴露全部 61 工具（默认）', standard: 'core+pro 52 个，隐藏 expert 高危/改自身类', minimal: '仅 core 21 个文件/查证/规划类' };

export default function Chat({ user, onLogout, onGoHome, onGoConsole, initialConvId }) {
  const [convs, setConvs] = useState([]);
  const [cur, setCur] = useState(null);
  const [curTitle, setCurTitle] = useState('');
  const [msgs, setMsgs] = useState([]);
  // M1：灰字系统行（意图/路由回显；不入历史/导出，仅本轮展示——§6.1/6.2 回显语义）
  const [sysline, setSysline] = useState(null); // { intent: {label,echo} | null, route: {profile,suggestProvider,suggestModel,echo} | null, ts }
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState('deepseek');
  const [model, setModel] = useState('');
  const [modelList, setModelList] = useState([]);
  const [input, setInput] = useState('');
  const inputRef = useRef('');      // 输入框最新值同步 ref（切换会话存档草稿用，防闭包读到旧值）
  // P3-7：草稿跨 Chat 挂载持久化（sessionStorage，前缀 rw_cdraft_ 与应用启动草稿 rw_draft_ 区分）
  const draftsRef = useRef({});
  const DRAFT_PREFIX = 'rw_cdraft_';
  useEffect(() => {
    try {
      const saved = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(DRAFT_PREFIX)) saved[String(k.slice(DRAFT_PREFIX.length))] = sessionStorage.getItem(k) || '';
      }
      draftsRef.current = saved;
    } catch { /* ignore */ }
  }, []);
  const saveDraftsToStorage = () => {
    try {
      const snapshot = { ...draftsRef.current };
      if (curRef.current && inputRef.current) snapshot[String(curRef.current)] = inputRef.current; // 含当前输入框
      for (const [cid, txt] of Object.entries(snapshot)) {
        if (txt) sessionStorage.setItem(DRAFT_PREFIX + cid, txt); else sessionStorage.removeItem(DRAFT_PREFIX + cid);
      }
    } catch { /* ignore */ }
  };
  useEffect(() => () => saveDraftsToStorage(), []);
  const [busy, setBusy] = useState(false);
  // 活动轮询（旁观/断连实时性兜底：事件环增量 + 活动条 + 完成自动刷新）
  const [live, setLive] = useState(null); // {last, tools, ts}
  const actSeqRef = useRef(0);
  const lastActRef = useRef(0);
  const busyRef = useRef(false);
  const curRef = useRef(null);      // 当前正在查看的会话 id（流式回调据此判断是否已切走，防跨会话污染）
  const busyConvRef = useRef(null); // 正在生成中的会话 id（发送时锁定，停止/结束时清空）
  const [stats, setStats] = useState({});
  const [kbOpen, setKbOpen] = useState(false); // ④ 知识库面板
  // 2026-09-09 去冗余：对话页⚙设置抽屉退役——能力/工具/规则/提案已由共享组件在后台 1.4/1.5 呈现，
  // 高级参数/MCP/定时任务→后台 1.8 设置，厂商/模型市场→后台 1.1 模型广场（服务端接口不变，仅入口迁移）
  const [provList, setProvList] = useState([]); // 全量厂商+模型（openConv 恢复会话模型选择 / switchProvider 级联用）
  const [toast, setToast] = useState('');
  const [queue, setQueue] = useState([]);       // 输入队列：执行中输入的消息排队，结束后自动发送
  const queueRef = useRef([]);                  // 队列同步 ref（回调判空/取队首不依赖闭包过期）
  const [renamingId, setRenamingId] = useState(null); // 正在重命名的会话 id（null=无）
  const [renameVal, setRenameVal] = useState('');
  // A2 会话挂壳：可用壳列表（启用中的非 default 壳）+ 当前会话挂载的壳 key（服务端 conv:shell 审计）
  const [shells, setShells] = useState([]);
  const [pends, setPends] = useState(null);     // 待处理审批/问询（断连/刷新后恢复）：{key, approvals, asks}
  const abortRef = useRef(null);
  const bottomRef = useRef(null);
  const msgsBoxRef = useRef(null);                       // 消息滚动容器（自动贴底跟随）
  const [stickBottom, setStickBottom] = useState(true);  // 用户是否停在底部：true=内容更新自动贴底；用户上翻=停止跟随
  const pollTickRef = useRef(0); // 轮询计数：每 3 tick（~7.5s）补拉一次挂起审批/问询（断连恢复）

  // —— 附件/整窗拖拽上传（2026-09-09 会话393 开发、09-09 恢复）：支持把 Excel/PDF/Word 等直接拖到对话页任意处上传 ——
  const [dragOverlay, setDragOverlay] = useState(false);
  const dragDepth = useRef(0);
  const hasFileDrag = (e) => {
    const t = e && e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
  };
  // 把"已上传"提示回填到输入框（按钮上传与整窗拖放共用）
  const appendAttach = (abs, rel, name) => {
    const c = curRef.current;
    const p = rel || abs || '';
    if (!p || !c) return;
    const t = '\n[📎 附件已上传：' + p + '（Excel 请用 extract_xlsx、PDF 用 extract_pdf、Word 用 extract_docx、文本/图片用 read_file/view_image 读取解析）]\n';
    const nv = (inputRef.current || '') + t;
    setInput(nv); inputRef.current = nv; draftsRef.current[c] = nv;
  };
  const onDropZoneDragEnter = (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOverlay(true);
  };
  const onDropZoneDragOver = (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDropZoneDragLeave = (e) => {
    if (!hasFileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOverlay(false);
  };
  const onDropZoneDrop = async (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragOverlay(false);
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!curRef.current) { setToast('请先选择会话再上传附件'); return; }
    const r = await uploadToServer(f, setToast);
    if (r) appendAttach(r.abs, r.rel, r.name);
  };

  const loadConvs = useCallback(async () => {
    try {
      const d = await api.conversations();
      setConvs(d.conversations);
    } catch (e) { setToast('会话列表加载失败：' + (e.message || e)); } // P3-3：失败不伪装成"无会话"
  }, []);

  const loadStats = useCallback(async (convId) => {
    try { const d = await api.usageStats(convId); setStats(d.stats); } catch { /* ignore */ }
  }, []);

  // P3-6：组件卸载（切首页/后台）中止进行中的流式请求，避免后台继续跑完烧 token
  useEffect(() => () => { if (abortRef.current) { try { abortRef.current.abort(); } catch { /* ignore */ } } }, []);
  useEffect(() => {
    loadConvs();
    // A2 会话挂壳下拉数据：启用中的非 default 壳
    api.shells().then((d) => setShells((d.shells || []).filter((s) => s.status === 'enabled' && s.skey !== 'default'))).catch(() => {});
    // 已接入厂商 + 各厂商模型列表（模型下拉用）
    api.providers().then((d) => {
      const active = d.providers.filter((p) => p.connected);
      setProviders(active.map((p) => ({ id: p.provider_key, name: p.name })));
      setProvList(d.providers);
      // B：仅当尚未打开任何会话时才以首家厂商设默认——已开会话的模型由 openConv 恢复（显式/auto 不在此覆盖，防竞态把 auto 覆盖成首家厂商）
      if (!curRef.current && active[0]) {
        setProvider(active[0].provider_key);
        const ms = active[0].models.filter((m) => m.enabled);
        setModelList(ms);
        setModel(ms[0]?.model_id || '');
      }
    }).catch(() => {});
  }, [loadConvs]);

  // M1/D9：从总览首页/应用广场直达会话（/chat?conv=<id>）——convs 加载完成后打开指定会话一次；
  // 应用启动草稿经 sessionStorage(rw_draft_<id>) 传递 → 打开后预填输入框（用户可编辑再发送）
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (initialConvId && convs.length && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      const target = convs.find((c) => c.id === Number(initialConvId));
      if (target) {
        openConv(target.id);
        try {
          const draft = sessionStorage.getItem('rw_draft_' + initialConvId);
          if (draft) {
            sessionStorage.removeItem('rw_draft_' + initialConvId);
            setInput(draft); inputRef.current = draft;
          }
        } catch { /* ignore */ }
      } else { setCurTitle('会话不存在或已删除'); }
    }
  // P0-3 修复（2026-09-09 对话页白屏）：依赖数组不得引用声明于其后的 const——原 [.., loadMessages]
  // 在渲染期求值命中 TDZ（Cannot access before initialization，压缩名 Xe），整页崩溃；effect 体内仅用 openConv（其内部才调 loadMessages），移除该依赖
  }, [initialConvId, convs]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchProvider = (pid) => {
    setProvider(pid);
    if (pid === 'auto') { setModelList([]); setModel('__auto__'); saveModelSel(pid, '__auto__'); return; }
    const p = provList.find((x) => x.provider_key === pid);
    const ms = (p?.models || []).filter((m) => m.enabled);
    setModelList(ms);
    const mid = ms[0]?.model_id || '';
    setModel(mid);
    saveModelSel(pid, mid); // 对话内模型：切厂商即把该会话选择写库（新对话继承当前选择）
  };

  // 会话模型快照写入（当前会话切换即保存；打开该会话时恢复）——模型跟会话走而非全局
  const saveModelSel = async (pid, mid) => {
    if (!cur) return;
    try {
      await api.patchConversation(cur, { provider: pid || null, model: mid || null });
      setConvs((cs) => cs.map((x) => (x.id === cur ? { ...x, provider: pid || null, model: mid || null } : x)));
    } catch { /* 静默：模型选择保存失败不打断 */ }
  };

  // M1：一键退回默认（route 灰字行旁）——清除该会话显式 provider/model，回落自动路由（C4：未显式选择才可被路由接管）
  const revertToDefault = async () => {
    if (!cur) return;
    try {
      await api.patchConversation(cur, { provider: null, model: null });
      setConvs((cs) => cs.map((x) => (x.id === cur ? { ...x, provider: null, model: null } : x)));
      // 会话无显式选择：前端回"自动路由"显示（模型下拉置 auto；会话 provider=null 由服务端回落默认路由）
      setProvider('auto');
      setModelList([]);
      setModel('__auto__');
      setSysline((prev) => ({ ...(prev || {}), route: null }));
      setToast('已退回默认：本会话按自动路由选择模型');
    } catch (e) { setToast(e.message); }
  };

  // 加载会话全部（消息+轨迹+统计）；openConv 与活动轮询完成刷新共用
  const loadMessages = async (id) => {
    if (!id) return;
    const [md, tc] = await Promise.all([api.messages(id), api.toolcalls(id).catch(() => ({ toolcalls: [] }))]);
    // 轨迹按 message_id 挂到对应 assistant 消息（历史回看）
    const byMsg = {};
    for (const t of tc.toolcalls || []) {
      const mid = t.message_id;
      if (mid) (byMsg[mid] = byMsg[mid] || []).unshift(t);
    }
    const msgsWithTraces = md.messages.map((msg) => {
      let m = msg.role === 'assistant' && byMsg[msg.id]
        // P3-3：历史轨迹 args 也过 safeJson（DB 存 JSON 字符串→对象；与 R5 抽屉同口径，humanTarget/文件打开可用）
        ? { ...msg, traces: byMsg[msg.id].map((t) => ({ name: t.tool_name, args: safeJson(t.args) ?? {}, result: t.result_summary, status: t.status, duration_ms: t.duration_ms, seq: 0 })) }
        : msg;
      if (msg.role === 'assistant' && msg.reasoning) m = { ...m, think: msg.reasoning }; // 历史思考过程回显
      return m;
    });
    setMsgs(msgsWithTraces);
    loadStats(id);
    const c = convs.find((x) => x.id === id);
    setCurTitle(c?.title || '对话');
  };

  const openConv = async (id) => {
    // 草稿按会话隔离：切走前保存当前会话未发送文字，切回时恢复（避免"输入的文字跨会话残留"）
    if (cur && cur !== id && inputRef.current) draftsRef.current[cur] = inputRef.current;
    const savedDraft = draftsRef.current[id] || '';
    setInput(savedDraft);
    inputRef.current = savedDraft;
    // P3-2：切换瞬间先清空旧会话内容/统计，避免加载期间错位残留（弱网可见明显）
    setMsgs([]); setStats({}); setLive(null);
    setCur(id);
    setStickBottom(true); // 切换会话：回到贴底跟随（避免停留在上一会话的滚动位置）
    actSeqRef.current = 0;
    lastActRef.current = 0;
    // 对话内模型：恢复该会话上次选择的厂商/模型；
    // P3-9：会话从未选过模型（provider 为空）→ 显示"自动路由"（服务端回落壳默认/全局默认），
    // 不被上一会话的显式选择"传染"成事实显式锁。
    const c = convs.find((x) => x.id === id);
    if (c?.provider) {
      const p = provList.find((x) => x.provider_key === c.provider);
      if (c.provider === 'auto') { setProvider('auto'); setModelList([]); setModel('__auto__'); }
      else if (p) {
        setProvider(c.provider);
        const ms = (p.models || []).filter((m) => m.enabled);
        setModelList(ms);
        setModel(c.model && ms.some((m) => m.model_id === c.model) ? c.model : (ms[0]?.model_id || ''));
      } else { setProvider(c.provider); setModelList([]); setModel(c.model || ''); }
    } else if (!c) {
      // 会话不存在（可能已被删/无权限）
      setCurTitle('会话不存在或已删除');
    } else {
      // 无显式模型：置自动路由展示（不污染其它会话选择状态——发送仍由本会话模型栏为准）
      setProvider('auto'); setModelList([]); setModel('__auto__');
    }
    try { await loadMessages(id); }
    catch { setCurTitle((c && c.title) || '对话'); setToast('加载该会话失败，请重试'); }
    fetchPending(); // 打开会话即检查服务端挂起的审批/问询（断连恢复入口）
  };

  const newConv = async () => {
    let d;
    try { d = await api.createConversation('新对话', 'full'); }
    catch (e) { setToast('新建会话失败：' + (e.message || e)); return; }
    // 会话级模型：新会话继承当前选中的厂商/模型（打开即恢复）
    try { await api.patchConversation(d.id, { provider, model: model || null }); } catch { /* ignore */ }
    await loadConvs();
    if (cur && inputRef.current) draftsRef.current[cur] = inputRef.current; // 离开当前会话：保留其草稿
    setCur(d.id); setCurTitle('新对话'); setMsgs([]); setStats({}); setStickBottom(true);
    setInput(''); inputRef.current = ''; // 新会话不继承任何会话的草稿
  };

  const delConv = async (id, e) => {
    e.stopPropagation();
    if (!confirm('删除该会话及其消息？')) return;
    // F：若删的是正在执行中的会话，先中止流（防 SSE 继续跑完写消息/烧 token/落孤儿）
    if (busyConvRef.current === id || (abortRef.current && curRef.current === id)) {
      api.stopChat(id).catch(() => {});
      if (abortRef.current) { try { abortRef.current.abort(); } catch { /* ignore */ } }
    }
    await api.deleteConversation(id);
    delete draftsRef.current[id]; // 删除会话同时清除其草稿
    try { sessionStorage.removeItem(DRAFT_PREFIX + id); } catch { /* ignore */ }
    // 同时丢弃该会话的排队消息（防删后滞留误发——审计 P2-1）
    queueRef.current = queueRef.current.filter((x) => x.convId !== id);
    setQueue(queueRef.current);
    if (cur === id) { setCur(null); setCurTitle(''); setMsgs([]); setStats({}); setInput(''); inputRef.current = ''; }
    loadConvs();
  };

  // —— 会话重命名（标题双击 或 ✎ 进入 inline 编辑：Enter 保存 / Esc 取消 / 失焦保存）——
  const startRename = (c) => { setRenamingId(c.id); setRenameVal(c.title || ''); };
  const saveRename = async (id) => {
    const title = renameVal.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      await api.patchConversation(id, { title });
      setConvs((cs) => cs.map((x) => (x.id === id ? { ...x, title } : x)));
      if (cur === id) setCurTitle(title);
      setToast('已重命名');
    } catch (e) { setToast(e.message); }
  };

  // —— 待处理审批/问询（断连/刷新后恢复：SSE 断开期间挂起的审批/问询仍在服务端等待，这里补拉并渲染横幅）——
  const pendDismissRef = useRef({}); // { key: ts }：某集合 dismiss 后 30s 内同集合不重弹（审计 P2-6：防"暂不处理"后轮询同 key 静默压制永远不恢复）
  const fetchPending = async () => {
    try {
      const [a, q] = await Promise.all([api.approvals(), api.asks()]);
      const items = [...(a.pending || []).map((x) => ({ kind: 'a', ...x })), ...(q.pending || []).map((x) => ({ kind: 'q', ...x }))];
      const key = items.length ? JSON.stringify(items.map((x) => x.id).sort()) : '';
      setPends((prev) => {
        if (prev && prev.key === key && !(prev.dismissedAt && Date.now() - prev.dismissedAt > 30000)) return prev;
        return { key, items, dismissedAt: null };
      });
    } catch { /* 忽略 */ }
  };

  // P1-F1 对话导出（Markdown）
  const exportConv = () => {
    if (!msgs.length) { setToast('当前会话无消息'); return; }
    const body = msgs.map((m) => {
      const who = m.role === 'user' ? '**我**' : '**AI**';
      const think = m.think ? m.think.split('\n').filter(Boolean).map((l) => '> 🧠 ' + l).join('\n') + '\n\n' : '';
      const t = (m.traces && m.traces.length ? m.traces.map((tr) => `> 🔧 ${tr.name}${tr.status === 'fail' ? ' ✕' : ''}${tr.result ? '\n> ' + String(tr.result).slice(0, 200) : ''}`).join('\n') + '\n\n' : '');
      return `## ${who}\n\n${think}${t}${m.content || ''}\n`;
    }).join('\n---\n\n');
    const blob = new Blob(['# ' + (curTitle || '对话') + '\n\n' + body], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = String(curTitle || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '对话'; // P3-22 文件名净化
    a.download = safeName + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500); // 延迟释放：立即 revoke 偶发截断下载
    setToast('对话已导出');
  };

  // P1-F2 快捷键：Ctrl+Enter 发送 / Ctrl+N 新对话 / Ctrl+E 导出
  useEffect(() => {
    const onKey = (e) => {
      // P3-20：内联编辑（会话重命名/其它 input）中按全局快捷键不应触发主对话动作
      const t = e.target;
      const inInline = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !(t.closest && t.closest('.rw-inputrow'));
      if (inInline) return;
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); send(); }
      if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newConv(); }
      if (e.ctrlKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); exportConv(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const stopGen = () => {
    const convId = busyConvRef.current || curRef.current;
    // 先通知服务端（abort 'user'：占位消息标记为"用户点击停止"而非"连接断开"），
    // 稍后本地断流；兜底 4s 强制断，避免 stopChat 未达时流一直挂着
    if (convId) api.stopChat(convId).catch(() => {});
    if (abortRef.current) { const ac = abortRef.current; setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, 300); }
    setBusy(false); busyConvRef.current = null;
    setMsgs((m) => m.map((x) => ({ ...x, streaming: false })));
    // 停止后：队列不会自动续发，明确告知状态（否则用户不知道排队消息是否还会执行）
    if (queueRef.current.length) {
      setToast('⏸ 任务已停止：' + queueRef.current.length + ' 条排队消息保留，可点「▶ 开始发送」或逐条移除/清空');
    } else {
      setToast('已停止当前任务');
    }
    // 停止后拉库对齐（服务端占位消息带中断原因+已执行进度），避免本地半截流内容与库不一致
    setTimeout(() => { if (curRef.current === convId) { loadMessages(convId).catch(() => {}); } }, 800);
  };

  // F20 审批裁决：批准/拒绝 guard 会话中挂起的高风险工具
  const decideApprovalMsg = async (id, decision) => {
    setMsgs((m) => m.map((x) => ({ ...x, approvals: (x.approvals || []).map((a) => (a.id === id ? { ...a, decision } : a)) })));
    try { await api.decideApproval(id, decision); setToast(decision === 'approve' ? '✅ 已批准，继续执行' : '已拒绝该操作'); }
    catch (e) { setToast(e.message); }
  };

  // 结构化问询：Agent 发选项卡片，用户点选后继续
  const answerAskMsg = async (id, value) => {
    setMsgs((m) => m.map((x) => ({ ...x, asks: (x.asks || []).map((q) => (q.id === id ? { ...q, chosen: value } : q)) })));
    try { await api.decideAsk(id, value); setToast('已选择：' + value); }
    catch (e) { setToast(e.message); }
  };

  // —— 输入队列：send 拆为 runText(实际发送体)/send(入队或直发)/flushQueue(结束后自动续发) ——
  const runText = async (convId, content) => {
    const text = String(content || '').trim();
    if (!text || busyRef.current) return;
    busyRef.current = true; setBusy(true); busyConvRef.current = convId;
    setInput('');
    inputRef.current = ''; delete draftsRef.current[convId]; // 内容已发出：清空输入框与该会话草稿
    const tmpId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    setMsgs((m) => [...m, { role: 'user', content: text }]);
    let acc = '';
    setSysline(null); // 新一轮开始：清空上一轮灰字（意图/路由回显仅当轮展示）
    setMsgs((m) => [...m, { _tmpId: tmpId, role: 'assistant', content: '', streaming: true, traces: [], think: '', plan: null, thinking: true, approvals: [], asks: [] }]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // 轨迹辅助：按 _tmpId 锚定本次流式消息（会话中途切换后不污染其它会话的消息/历史加载结果）
      const patchLast = (fn) => setMsgs((prev) => (curRef.current === convId ? prev.map((x) => (x._tmpId === tmpId ? fn(x) : x)) : prev));
      await streamChat({ conversationId: convId, content: text, provider, model: model || undefined },
        {
          onDelta: (delta) => {
            acc += delta;
            patchLast((x) => ({ ...x, content: acc, thinking: false }));
          },
          onThinking: () => {
            // 新一轮 LLM 调用开始：恢复“思考中”指示（工具完成后→下一轮输出间的空白期有反馈）
            patchLast((x) => ({ ...x, thinking: true }));
          },
          onThink: (text) => {
            // 思考过程实时累积（灰色斜体区）
            patchLast((x) => ({ ...x, think: (x.think || '') + text, thinking: false }));
          },
          onToolStart: (tool) => {
            // 工具开始：先降级"已流正文"为过程说明（P22：工具轮旁白灰字展示、不入气泡），再追加"运行中"卡片
            patchLast((x) => {
              let n = { ...x };
              if (n.content && !n._demoted) {
                n = { ...n, think: (n.think ? n.think + '\n' : '') + '（过程说明）' + n.content, content: '', _demoted: true };
              }
              return { ...n, thinking: false, traces: [...(n.traces || []), { ...tool, status: 'running' }] };
            });
          },
          onToolDone: (tool) => {
            // 工具完成：按 名字+seq(+子代理) 唯一匹配更新卡片（父/子代理交错不撞号）
            patchLast((x) => ({
              ...x,
              traces: (x.traces || []).map((t) =>
                (t.name === tool.name && t.seq === tool.seq && (t.sub ?? null) === (tool.sub ?? null)) ? { ...tool } : t),
            }));
          },
          onPlan: (plan) => {
            // 任务清单进度实时更新
            patchLast((x) => ({ ...x, plan }));
          },
          onApproval: (ap) => {
            // 审批请求：追加确认卡（guard 会话高风险工具）
            patchLast((x) => ({ ...x, approvals: [...(x.approvals || []), { id: ap.id, desc: ap.desc, decision: null }] }));
          },
          onAsk: (q) => {
            // 结构化问询：追加选项卡片
            patchLast((x) => ({ ...x, asks: [...(x.asks || []), { id: q.id, question: q.question, options: q.options || [], chosen: null }] }));
          },
          // M1 灰字回显（系统行，不入历史/导出）：意图识别 + 档案路由建议（§6.1/6.2/§8）
          onIntent: (ev) => setSysline((prev) => ({ intent: { label: ev.label, echo: ev.echo || '' }, route: (prev && prev.route) || null, ts: Date.now() })),
          onRoute: (ev) => setSysline((prev) => ({ intent: (prev && prev.intent) || null, route: { profile: ev.profile, suggestProvider: ev.suggestProvider, suggestModel: ev.suggestModel, echo: ev.echo || '' }, ts: Date.now() })),
          onDone: () => {
            patchLast((x) => ({ ...x, streaming: false, thinking: false }));
            setBusy(false); busyConvRef.current = null;
            // 仍在看本会话才刷新统计（防覆盖已切走会话的显示）；消息轨迹已随 tool_done 实时入 msgs[].traces
            if (curRef.current === convId) {
              loadStats(convId);
            }
            // 智能起名：回复完成后若标题仍为默认，用 LLM 生成精髓标题（服务端仅默认名才更新，保护手动重命名）
            api.autoTitle(convId).then((d) => { if (d && d.ok && d.title) { setConvs((cs) => cs.map((x) => (x.id === convId ? { ...x, title: d.title } : x))); if (curRef.current === convId) setCurTitle(d.title); } }).catch(() => {});
            flushQueue(); // 本轮回合结束：如有排队消息自动发送下一条
          },
          onError: (msg) => {
            setToast(msg); setBusy(false); busyConvRef.current = null;
            patchLast((x) => ({ ...x, streaming: false, thinking: false, error: msg }));
            // 错误结束不自动续发队列：避免“停止”误触发排队消息自动发送；用户可再次回车/发送续上
          },
        },
        ac.signal);
    } catch (ex) {
      const isStop = ex.name === 'AbortError';
      if (!isStop) setToast(ex.message);
      setBusy(false); busyConvRef.current = null;
      // 只收尾本次流消息（_tmpId 锚定，不污染其它会话）；发送失败时提示并恢复输入内容
      setMsgs((prev) => prev.map((x) => (x._tmpId === tmpId ? { ...x, streaming: false, thinking: false, error: isStop ? undefined : String(ex.message || '发送失败') } : x)));
      if (!isStop && curRef.current === convId && !acc) { setInput(text); inputRef.current = text; draftsRef.current[convId] = text; } // 发送失败：恢复输入并保留草稿
      if (!isStop) flushQueue(); // 用户主动停止：队列保留（停止后仍可手动发/点停止仅中止当前轮）；异常结束：继续队列
    }
  };

  // send：Enter/点发送 → 空闲直接发；任务执行中则入队（结束后自动续发）
  const send = async () => {
    const content = input.trim();
    if (!content || !cur) return;
    if (busyRef.current) {
      // 队列项携带归属会话：任务中切会话/删会话不会串发（审计 P2-1）
      const item = { convId: cur, text: content, uid: Date.now() + '-' + Math.random().toString(36).slice(2, 7) };
      queueRef.current = [...queueRef.current, item];
      setQueue(queueRef.current); setInput(''); inputRef.current = ''; delete draftsRef.current[cur]; // 已入队将发送：不留草稿
      setToast('⏳ 任务执行中：已排队 ' + queueRef.current.length + ' 条，结束后自动发送');
      return;
    }
    await runText(cur, content);
  };

  // flushQueue：上一轮结束后自动发送下一条排队消息（function 声明提升，runText 同步路径可安全调用）
  // 只消费归属==当前会话的首条（其余会话排队消息保留——切回该会话后由结束轮自动续发/手动点发）
  async function flushQueue() {
    if (busyRef.current || !curRef.current) return;
    const q = queueRef.current;
    if (!q.length) return;
    const idx = q.findIndex((it) => it.convId === curRef.current);
    if (idx < 0) return; // 无本会话排队项（可能已切走/删会话）
    const next = q[idx];
    queueRef.current = q.filter((_, i) => i !== idx);
    setQueue(queueRef.current);
    setToast('▶ 自动发送排队消息（剩 ' + queueRef.current.filter((it) => it.convId === curRef.current).length + ' 条）');
    await runText(curRef.current, next.text);
  }

  // 队列管理：逐条移除（按项引用） / 清空本会话（停止后队列保留，用户可自主决定续发或丢弃）
  const removeQueueAt = (item) => {
    const q = queueRef.current.filter((x) => x !== item);
    queueRef.current = q; setQueue(q);
    setToast(q.length ? '已移除该条排队消息' : '队列已清空');
  };
  const clearQueue = () => {
    // 仅清当前会话排队项（其它会话项保留——防跨会话误清）
    const q = queueRef.current.filter((x) => x.convId !== cur);
    queueRef.current = q; setQueue(q);
    setToast('已清空本会话排队消息');
  };

  // 活动轮询（旁观/断连兜底）：当前会话每 2.5s 拉事件环增量；
  // 本页 busy（SSE 直连渲染中）只推进 seq 不重复渲染；静默>6s 视为本轮结束→自动刷新最新结果
  React.useEffect(() => { busyRef.current = busy; }, [busy]);
  React.useEffect(() => { curRef.current = cur; }, [cur]); // 会话切换即时同步（流式回调守卫用）
  React.useEffect(() => {
    if (!cur) return;
    const t = setInterval(async () => {
      try {
        // 每 ~7.5s 补拉一次服务端挂起的审批/问询（SSE 断开/刷新后的恢复兜底入口）
        pollTickRef.current = (pollTickRef.current || 0) + 1;
        if (pollTickRef.current % 3 === 0) fetchPending();
        const d = await api.activity(cur, actSeqRef.current);
        const items = (d && d.items) || [];
        if (!items.length) {
          // 空=仍在执行（LLM 思考间隙）或已结束但 run_end 未达：30s 兜底清理活动条
          if (lastActRef.current && Date.now() - lastActRef.current > 30000) { lastActRef.current = 0; setLive(null); }
          return;
        }
        actSeqRef.current = d.seq || actSeqRef.current;
        lastActRef.current = Date.now();
        const ended = items.some((x) => x.type === 'run_end');
        if (ended) { lastActRef.current = 0; setLive(null); if (!busyRef.current) loadMessages(cur); return; }
        if (busyRef.current) return; // 本页 SSE 直连渲染中，环仅作进度推进
        const last = items[items.length - 1];
        setLive({ last: (last.type === 'tool_start' || last.type === 'tool_done') && last.tool ? last.tool.name : last.type, ts: Date.now() });
      } catch { /* 轮询失败静默（断网/会话删除） */ }
    }, 2500);
    return () => clearInterval(t);
  }, [cur]);

  const changePermission = async (perm) => {
    await api.patchConversation(cur, { permission: perm });
    setConvs((cs) => cs.map((c) => (c.id === cur ? { ...c, permission: perm } : c)));
    setToast('权限已切换为 ' + PERM_LABEL[perm]);
  };

  const changePreset = async (preset) => {
    await api.patchConversation(cur, { preset });
    setConvs((cs) => cs.map((c) => (c.id === cur ? { ...c, preset } : c)));
    setToast('工具预设已切换为 ' + PRESET_LABEL[preset] + '（' + PRESET_TIP[preset] + '）');
  };

  // A2 会话挂壳：切换当前会话挂载的壳（''=摘下回默认中性语义）；服务端审计 conv:shell
  const changeConvShell = async (skey) => {
    if (!cur) return;
    const curShell = convs.find((c) => c.id === cur)?.shell_key || '';
    if (skey === curShell) return;
    try {
      await api.patchConversation(cur, { shell: skey || null });
      const s = shells.find((x) => x.skey === skey);
      setConvs((cs) => cs.map((c) => (c.id === cur ? { ...c, shell_key: skey || null, shell_id: skey ? c.shell_id : null, shell_name: skey ? (s ? s.name : '') : null } : c)));
      setToast(skey ? '已挂壳：' + (s ? s.name : skey) + '（新消息按该壳身份/工具面执行）' : '已摘下壳（回默认中性语义）');
    } catch (e) { setToast(e.message || '切换壳失败'); }
  };

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(''), 2500); return () => clearTimeout(t); }
  }, [toast]);

  // —— 阅读体验 v3：贴底跟随（仅当用户停在底部才自动贴底；用户上翻即停，流式/思考更新不再强拽页面）——
  useEffect(() => {
    const el = msgsBoxRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      setStickBottom((prev) => (prev === near ? prev : near));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (!stickBottom) return;
    const el = msgsBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight; // 即时贴底（无 smooth 动画：高频流式不卡顿、可随时上翻打断）
  }, [msgs, stickBottom]);

  const curPerm = convs.find((c) => c.id === cur)?.permission || 'full';
  const curPreset = convs.find((c) => c.id === cur)?.preset || 'all';
  const curShellKey = convs.find((c) => c.id === cur)?.shell_key || '';

  return (
    <div className="rw-shell" onDragEnter={onDropZoneDragEnter} onDragOver={onDropZoneDragOver} onDragLeave={onDropZoneDragLeave} onDrop={onDropZoneDrop}>
      {/* 整窗拖拽上传遮罩：拖入文件时提示松开上传 */}
      {dragOverlay && (
        <div className="rw-dropoverlay">
          <div className="rw-dropoverlay-inner">📥 松开上传（Excel/PDF/Word/PPT/图片/文本，≤8MB）</div>
        </div>
      )}
      {/* 顶栏：logo 左上 + 对话标题 + 操作（M1：logo/首页 → 总览首页） */}
      <header className="rw-topbar">
        <div className="rw-logo" onClick={() => { if (onGoHome) onGoHome(); else { setCur(null); setMsgs([]); } }} title="返回总览首页">Roni Workbench</div>
        <div className="rw-conv-title">{curTitle || 'Roni Workbench'}</div>
        <div className="rw-top-actions">
          {onGoConsole && <button className="rw-btn" onClick={() => onGoConsole()} title="统一后台">🎛 后台</button>}
          <button className="rw-btn" onClick={() => { if (onGoHome) onGoHome(); else { setCur(null); setMsgs([]); } }} title="返回总览首页">🏠 首页</button>
          <button className="rw-btn" onClick={() => setKbOpen(true)} title="知识库：上传/管理（④）">📚 知识</button>
          {cur && <button className="rw-btn" onClick={exportConv} title="导出对话 (Ctrl+E)">⬇ 导出</button>}
          {cur && (
            <select className="rw-select" value={curPerm} onChange={(e) => changePermission(e.target.value)} title="会话权限">
              {Object.entries(PERM_LABEL).map(([k, v]) => <option key={k} value={k}>权限：{v}</option>)}
            </select>
          )}
          {cur && (
            <select className="rw-select" value={curPreset} onChange={(e) => changePreset(e.target.value)} title={'工具预设：' + PRESET_TIP[curPreset]}>
              {Object.entries(PRESET_LABEL).map(([k, v]) => <option key={k} value={k}>工具：{v}</option>)}
            </select>
          )}
          {cur && (
            <select className="rw-select" value={curShellKey} onChange={(e) => changeConvShell(e.target.value)} title="会话挂壳：按壳身份/工具面/知识范围执行；空=默认中性（§8.9/§5.5 会话内选壳）">
              <option value="">壳：无（中性）</option>
              {shells.map((s) => <option key={s.skey} value={s.skey}>壳：{s.name}</option>)}
            </select>
          )}
        </div>
      </header>

      <div className="rw-body">
        {/* 左栏 */}
        <aside className="rw-side">
          <button className="rw-btn pri rw-newbtn" onClick={newConv}>＋ 新建对话</button>
          <div className="rw-side-list">
            {convs.map((c) => (
              <div key={c.id} className={'rw-conv' + (cur === c.id ? ' sel' : '')} onClick={() => { if (renamingId !== c.id) openConv(c.id); }}>
                {renamingId === c.id
                  ? <input className="rw-input rw-rename-input" autoFocus value={renameVal}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameVal(e.target.value)}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') saveRename(c.id); else if (e.key === 'Escape') setRenamingId(null); }}
                      onBlur={() => { if (renamingId === c.id) saveRename(c.id); }} />
                  : <span className="rw-conv-t" title="双击重命名" onDoubleClick={() => startRename(c)}>{c.title}</span>}
                <span className="rw-conv-tag">{c.channel !== 'web' ? c.channel : ''}</span>
                {c.shell_key && <span className="rw-conv-tag" title={'挂载壳：' + (c.shell_name || c.shell_key)}>🫧{c.shell_key}</span>}
                {c.preset && c.preset !== 'all' && <span className="rw-conv-tag" title={'工具预设：' + PRESET_TIP[c.preset]}>P:{PRESET_LABEL[c.preset] || c.preset}</span>}
                <button className="rw-conv-rename" title="重命名" onClick={(e) => { e.stopPropagation(); startRename(c); }}>✎</button>
                <button className="rw-conv-del" onClick={(e) => delConv(c.id, e)} title="删除">✕</button>
              </div>
            ))}
          </div>
          <div className="rw-side-foot">
            {/* 2026-09-09 去冗余：⚙设置抽屉退役——能力/工具/规则/提案/高级参数/MCP/定时任务统一在「🎛 后台」1.1/1.4/1.5/1.8 */}
            <span className="rw-user">{user.username}</span>
            <button className="rw-btn" onClick={onLogout} title="退出">↪</button>
          </div>
        </aside>

        {/* 对话区 */}
        <main className="rw-main">
          <div className="rw-chat-modelbar">
            <span className="rw-chat-model-lb" title="模型跟随当前对话，切换只影响本对话">🤖 本对话模型</span>
            <select className="rw-select" value={provider} onChange={(e) => switchProvider(e.target.value)} title="厂商：切厂商后选模型">
              <option value="auto">自动路由</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="rw-select rw-model-sel" value={model} onChange={(e) => { const mv = e.target.value; setModel(mv); saveModelSel(provider, mv); }} title="模型（豆包/DeepSeek 等，随本对话保存）">
              {provider === 'auto' && <option value="__auto__">自动（由平台路由）</option>}
              {modelList.length ? modelList.map((m) => <option key={m.model_id} value={m.model_id}>{m.name || m.model_id}</option>) : (provider !== 'auto' ? <option value="">默认</option> : null)}
            </select>
          </div>
          {pends && pends.items && pends.items.length > 0 && (
            <div className="rw-pendbar">
              <b className="rw-pend-title">⚠ 待处理请求（断连/刷新后可在此补答）</b>
              {pends.items.map((x) => (x.kind === 'a'
                ? <span key={x.id} className="rw-pend-item"><span className="rw-pend-tag">审批</span><code className="rw-pend-code">{x.desc}</code>
                  <button className="rw-btn pri" onClick={() => decideApprovalMsg(x.id, 'approve')}>批准</button><button className="rw-btn" onClick={() => decideApprovalMsg(x.id, 'reject')}>拒绝</button></span>
                : <span key={x.id} className="rw-pend-item"><span className="rw-pend-tag">问询</span>{x.question}{(x.options || []).map((o) => <button key={o.value} className="rw-btn" onClick={() => answerAskMsg(x.id, o.value)}>{o.label}</button>)}</span>))}
              <button className="rw-btn" onClick={() => setPends((p) => (p ? { ...p, items: [], dismissedAt: Date.now() } : p))}>暂不处理（30s 后可再提醒）</button>
            </div>
          )}
          {live && (
            <div className="rw-livebar" title="该会话正在执行中（旁观实时状态）">
              <span className="rw-live-dot" /> 正在执行…
              {live.last ? <span className="rw-live-cur">当前：{String(live.last).slice(0, 40)}</span> : <span className="rw-live-cur">思考中</span>}
            </div>
          )}
          <div className="rw-msgs" ref={msgsBoxRef}>
            {!cur && <div className="rw-empty">← 新建或选择左侧会话，开始对话</div>}
            {cur && !msgs.length && !busy && <div className="rw-empty">新会话 · 直接输入消息开始对话；任务类需求（修代码/查文件/联网等）将自动切换 Agent 模式</div>}
            {cur && !msgs.length && busy && <div className="rw-empty">正在启动…</div>}
            {msgs.map((m, i) => (
              <div key={m.id || m._tmpId || i} className={'rw-msg ' + (m.role === 'user' ? 'me' : 'ai') + (m.streaming ? ' stream' : '')}>
                <div className="rw-msg-role">{m.role === 'user' ? '我' : 'AI'}</div>
                <div className="rw-msg-c">
                  {m.role === 'assistant'
                    ? <>
                        {m.plan && m.plan.length > 0 && <PlanCard plan={m.plan} />}
                        {m.think ? <ThinkBox text={m.think} streaming={Boolean(m.streaming)} /> : null}
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
                        {m.asks && m.asks.length > 0 && m.asks.map((q) => (
                          <div key={q.id} className="rw-ask">
                            <div className="rw-ask-q">❓ {q.question}</div>
                            {q.chosen
                              ? <div className="rw-ask-chosen">已选择：{q.options.find((o) => o.value === q.chosen)?.label || q.chosen}</div>
                              : <div className="rw-ask-opts">
                                  {q.options.map((o) => (
                                    <button key={o.value} className="rw-btn" onClick={() => answerAskMsg(q.id, o.value)}>{o.label}</button>
                                  ))}
                                </div>}
                          </div>
                        ))}
                        {m.traces && m.traces.length > 0 && <TracePanel traces={m.traces} streaming={Boolean(m.streaming)} />}
                        {m.thinking && !m.content && <div className="rw-thinking">🤔 AI 思考中…</div>}
                        {m.error ? <div className="rw-err">⚠️ {m.error}</div> : null}
                        {!m.error && m.content && (m.streaming ? <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span> : <Md text={m.content} />)}
                        {!m.error && !m.content && !m.thinking && m.streaming && <span className="rw-caret">▋</span>}
                        {!m.error && !m.content && !m.streaming && (
                          <div className="rw-emptynote">{
                            m.traces && m.traces.length
                              ? '（本轮只执行了工具操作、未产出文本——结果见上方工具轨迹）'
                              : (m.plan && m.plan.length ? '（本轮仅规划，未产出正文）' : '（本轮未产生文本输出）')
                          }</div>
                        )}
                      </>
                    : <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          {/* M1：灰字系统行——意图/路由回显，仅当轮展示、不入历史与导出（§8） */}
          {sysline && (sysline.intent || sysline.route) && (
            <div className="rw-sysline">
              {sysline.intent && sysline.intent.label && (
                <span className="rw-sysline-intent">
                  <span className="rw-sysline-tag">意图</span>{sysline.intent.echo || sysline.intent.label}
                </span>
              )}
              {(sysline.route) && (sysline.route.profile || sysline.route.suggestProvider) && (
                <span className="rw-sysline-route">
                  <span className="rw-sysline-tag">路由</span>{sysline.route.echo || ('已按档案 ' + sysline.route.profile + ' 使用 ' + sysline.route.suggestModel)}
                  {cur && <button className="rw-btn rw-sysline-revert" onClick={revertToDefault} title="清除本会话显式模型选择，回落自动路由">↩ 退回默认</button>}
                </span>
              )}
            </div>
          )}
          <div className="rw-stats">
            {Object.keys(stats).length > 0 && (
              <span>{stats.rounds} 轮 · {stats.steps} 步 ｜ LLM {(stats.llmMs / 1000).toFixed(1)}s ｜ 输入 {stats.tokensIn} tok · 输出 {stats.tokensOut} tok{stats.cost ? ' ｜ ¥' + Number(stats.cost).toFixed(4) : ''}</span>
            )}
          </div>
          <div className="rw-inputbar">
            <div className="rw-inputbox">
              {queue.some((x) => x.convId === cur) && (
                <div className="rw-queuepanel">
                  <div className="rw-queuehead">
                    <span className={'rw-queuestate' + (busy ? ' on' : '')}>{busy ? '⏳ 任务执行中' : '⏸ 已停止'}</span>
                    <span className="rw-queuecnt">本会话排队 <b>{queue.filter((x) => x.convId === cur).length}</b> 条</span>
                    <span className="rw-queueops">
                      {!busy && <button className="rw-btn" onClick={flushQueue} title="发送本会话排队消息">▶ 开始发送</button>}
                      <button className="rw-btn" onClick={clearQueue} title="丢弃本会话排队消息">🗑 清空</button>
                    </span>
                  </div>
                  <div className="rw-queuelist">
                    {queue.filter((it) => it.convId === cur).map((q) => (
                      <div className="rw-queueitem" key={q.uid}>
                        <span className="rw-queuetxt">{q.text}</span>
                        <button className="rw-queuedel" onClick={() => removeQueueAt(q)} title="移除该条">✕</button>
                      </div>
                    ))}
                  </div>
                  <div className="rw-queuenote">{busy ? '当前任务结束后自动按序发送；点「■ 停止」中止后队列保留，可手动续发/清空' : '任务已停止：队列不会自动发送，可点「▶ 开始发送」续发，或移除/清空不需要的消息'}</div>
                </div>
              )}
              <div className="rw-inputrow">
                <textarea className="rw-input" rows="3" placeholder="输入消息：Enter 发送，Shift+Enter 换行；任务执行中输入也会照常发送，自动排队…" value={input}
                  onChange={(e) => { setInput(e.target.value); inputRef.current = e.target.value; }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); send(); }
                  }} disabled={!cur} />
                <div className="rw-inputtools">
                  <FileAttach disabled={!cur} onToast={setToast}
                    onAttached={(abs, rel, name) => { appendAttach(abs, rel, name); }} />
                  <span className={'rw-input-hint' + (busy ? ' busy' : '')}>{busy ? '⏳ 任务执行中：发送的新消息会自动排队，当前任务结束后按序执行' : ''}</span>
                  <div className="rw-inputbtns">
                    {busy && <button className="rw-btn stop" onClick={stopGen} title="停止当前生成（排队消息保留，可再点发送继续）">■ 停止</button>}
                    <button className="rw-btn pri" onClick={send} disabled={!cur || !input.trim()} title="发送（Enter）；任务执行中点击也会发送——自动加入队列，结束后依次执行">{busy ? '⏎ 发送（排队）' : '发送'}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {kbOpen && <Knowledge onClose={() => setKbOpen(false)} />}

      {toast && <div className="rw-toast">{toast}</div>}
    </div>
  );
}

/* ============================================================
   阅读体验 v3（2026-09）：轨迹/思考对人友好
   - 工具名中文化 + 目标摘要（轨迹行是给人看的，不是给 AI 看的）
   - ThinkBox：思考区流式期间自动贴底；结束后可自由开合细读
   - TracePanel：整轮工具过程收进单一可折叠面板，默认摘要一行
   ============================================================ */
const TRACE_LABEL = {
  read_file: '读取文件', write_file: '写入文件', append_file: '追加内容', edit_file: '修改文件',
  delete_file: '删除文件', list_dir: '查看目录', find_file: '查找文件', grep_search: '搜索内容',
  repo_map: '生成代码地图', run_command: '执行命令', run_test: '运行测试', syntax_check: '语法检查',
  plan_tasks: '规划任务', plan_done: '标记步骤', finish_task: '任务提测', web_search: '联网搜索',
  fetch_url: '抓取网页', db_query: '查询数据库', db_write: '写入数据库',
  git_commit: '提交 Git', git_status: '查看 Git 状态', undo_checkpoint: '撤销快照',
  kb_add: '写入记忆', kb_search: '搜索记忆', skill_load: '载入技能', skill_save: '保存技能',
  subagent: '子代理执行', ask_user: '向你提问', set_limits: '调整护栏', set_goal: '设定目标',
  reload_platform: '重载平台', hooks_list: '查看钩子',
  read_file_range: '分段读取', extract_pdf: '解析 PDF', extract_docx: '解析 Word', view_image: '查看图片',
  ocr_image: '识别图片'
};
const humanTool = (name) => TRACE_LABEL[name] || String(name || '');

const humanTarget = (t) => {
  if (!t || !t.args || typeof t.args !== 'object') return '';
  const a = t.args;
  const p = a.path || a.file || a.src;
  if (p) {
    let s = String(p);
    s = s.replace(/^\/srv\/harness-workbench\//, 'rw/').replace(/^\/srv\/rw-workspace\//, 'ws/');
    return s.length > 48 ? '…' + s.slice(-48) : s;
  }
  if (a.url) return String(a.url).slice(0, 64);
  if (typeof a.q === 'string' && a.q) return '「' + a.q.slice(0, 42) + '」';
  if (a.query) return '「' + String(a.query).slice(0, 42) + '」';
  if (a.cmd) return String(a.cmd).slice(0, 56);
  if (a.sql) return String(a.sql).slice(0, 56);
  if (a.name) return String(a.name).slice(0, 40);
  if (a.question) return '「' + String(a.question).slice(0, 42) + '」';
  return '';
};

function ThinkBox({ text, streaming }) {
  const box = useRef(null);
  const near = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && streaming && near.current) el.scrollTop = el.scrollHeight;
  }, [text, streaming]);
  const onScroll = () => {
    const el = box.current;
    if (el) near.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 90;
  };
  const title = streaming ? '思考中（可点击收起）' : '思考过程';
  return React.createElement('details', { className: 'rw-think', open: streaming || undefined },
    React.createElement('summary', null, title),
    React.createElement('div', { ref: box, onScroll: onScroll, style: { whiteSpace: 'pre-wrap' } }, text));
}

// TracePanel：整轮工具过程收进一个可折叠面板
function TracePanel({ traces, streaming }) {
  const groups = groupTraces(traces);
  const running = traces.find((t) => t.status === 'running');
  const failed = groups.find((g) => g.items.some((x) => x.status === 'fail'));

const desc = running ? '正在' + humanTool(running.name) + '…' : (failed ? '出错：' + humanTool(failed.name) : '');

  const dot = React.createElement('span', { className: 'rw-tracebox-dot' + ((streaming || running) ? ' run' : '') });
  const title = React.createElement('span', { className: 'rw-tracebox-title' }, '工具过程 · ' + traces.length + ' 次');
  const head = React.createElement('span', { className: 'rw-tracebox-sum' }, dot, title, desc ? React.createElement('span', { className: 'rw-tracebox-desc' }, desc) : null);

  const arrow = React.createElement('span', { className: 'rw-tracebox-arrow' }, '展开查看明细');
  return React.createElement('details', { className: 'rw-tracebox', open: streaming || undefined },
    React.createElement('summary', null, head, arrow),
    React.createElement('div', { className: 'rw-tracebody' },
      groups.map((g, gi) => React.createElement(TraceCard, { key: gi, items: g.items }))));
}
