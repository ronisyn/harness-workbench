// server/knowledge.js - ④ 知识库 v1 数据面（§6.3/§8）：可见性 SQL 构造 + 上传解析（纯函数，不碰 DB）
// 依据方案：scope=global 全局共享 / scope=shell 仅该壳会话可见 / scope=conv 仅本会话；
// 会话可见范围 = 全局 + 本会话所属壳私有 + 本会话私有；默认"壳私有 + 全局共享"（§4）。
// 上传链：xlsx 按行结构化优先（首列=title、整行=body，可带表头）；txt/md 按空行分段；csv 经 xlsx 行解析。

// 会话可见知识 SELECT 条件（规划统一出口防漏 WHERE——总方案 §9.3④ 登记：现 F19 注入/kb_search/kb_del 各自内联同构 SQL，本函数尚未被生产引用，接线随知识库批）
// opts.shellId = 会话所属壳 id（可为 null/undefined=无壳会话）；opts.conversationId = 本会话
export function kbVisibleWhere(opts = {}) {
  const { accountId, shellId, conversationId, includeConv = true, scopeOnly } = opts;
  const conds = ['account_id=?'];
  const params = [accountId];
  // scopeOnly：管理面按范围过滤（list）；缺省=会话可见语义（global + 壳 + 本会话）
  if (scopeOnly) {
    conds.push('scope=?');
    params.push(scopeOnly);
    if (scopeOnly === 'shell' && shellId) { conds.push('shell_id=?'); params.push(shellId); }
    if (scopeOnly === 'conv' && conversationId) { conds.push('conversation_id=?'); params.push(conversationId); }
    return { where: conds.join(' AND '), params };
  }
  conds.push('(scope="global" OR (scope="shell" AND shell_id<=>?)');
  params.push(shellId || null);
  if (includeConv) { conds[conds.length - 1] += ' OR (scope="conv" AND conversation_id=?)'; params.push(conversationId || -1); }
  conds[conds.length - 1] += ')';
  return { where: conds.join(' AND '), params };
}

// ---------- 上传解析 ----------
// xlsx/xls/csv：按行结构化。行→ {title, body}
// 行映射（用户确认）：首列=title；body=该行其余列 "列名: 值" 拼接；hasHeader=true 时首行作列名（默认）；
// 列名缺失回退 colN；无首列单元格的行 title 回退 `${basename}-第N行`；全空行跳过。
export function rowsToEntries(rows, { basename = 'sheet', hasHeader = true } = {}) {
  const out = [];
  if (!Array.isArray(rows) || !rows.length) return out;
  let cols = [];
  let start = 0;
  if (hasHeader) {
    cols = (rows[0] || []).map((c, i) => String(c == null ? '' : c).trim() || ('col' + (i + 1)));
    start = 1;
  }
  for (let i = start; i < rows.length; i++) {
    const cells = (rows[i] || []).map((c) => (c == null ? '' : String(c)).trim());
    if (!cells.some((c) => c !== '')) continue; // 全空行跳过
    const title = cells[0] || (basename + '-第' + (i + 1) + '行');
    const rest = [];
    for (let j = 1; j < cells.length; j++) {
      if (cells[j] === '') continue;
      const name = (cols[j] || 'col' + (j + 1));
      rest.push(name + ': ' + cells[j]);
    }
    out.push({ title: String(title).slice(0, 200), body: rest.join('\n').slice(0, 8000) });
  }
  return out;
}

// txt/md：按空行分段 → 每段一条（title=段首行截断，body=整段）；json：数组[{title/name, body/content}] 或整文件一条
export function textToEntries(text, { basename = 'doc' } = {}) {
  const out = [];
  const blocks = String(text || '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  for (const b of blocks) {
    const lines = b.split('\n');
    out.push({ title: lines[0].slice(0, 200) || basename, body: b.slice(0, 8000) });
  }
  if (!out.length) out.push({ title: basename, body: String(text || '').trim().slice(0, 8000) });
  return out;
}

// 统一入口：name(文件名) + data(base64) → { ext, rows: [{title,body}], skipped[] }（纯解析；不碰 DB）
export async function parseKnowledgeUpload(name, dataBase64, { hasHeader = true } = {}) {
  const base = String(name || 'knowledge');
  const ext = (base.includes('.') ? base.split('.').pop() : '').toLowerCase();
  const b64 = String(dataBase64 || '').replace(/^data:[^;]*;base64,/, '');
  if (!b64) throw new Error('上传内容为空');
  try {
    if (['xlsx', 'xls', 'csv'].includes(ext)) {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(b64, { type: 'base64' });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new Error('文件无工作表');
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });
      return { ext, basename: base.replace(/\.[^.]+$/, ''), rows: rowsToEntries(rows, { basename: base.replace(/\.[^.]+$/, ''), hasHeader: ext !== 'csv' ? hasHeader : hasHeader }) };
    }
    if (['txt', 'md', 'json'].includes(ext)) {
      const buf = Buffer.from(b64, 'base64');
      const text = buf.toString('utf8');
      if (ext === 'json') {
        let arr = null;
        try {
          const j = JSON.parse(text);
          if (Array.isArray(j)) arr = j;
          else if (j && Array.isArray(j.items)) arr = j.items;
        } catch { arr = null; }
        if (arr && arr.length) {
          const rows = arr.map((o) => ({
            title: String(o.title || o.name || (o[0] != null ? o[0] : '') || '').slice(0, 200),
            body: String(o.body || o.content || JSON.stringify(o)).slice(0, 8000),
          })).filter((r) => r.title);
          return { ext, basename: base.replace(/\.[^.]+$/, ''), rows };
        }
      }
      return { ext, basename: base.replace(/\.[^.]+$/, ''), rows: textToEntries(text, { basename: base.replace(/\.[^.]+$/, '') }) };
    }
    throw new Error('不支持的文件类型 .' + (ext || '未知') + '（支持 xlsx/xls/csv/txt/md/json）');
  } catch (e) {
    throw new Error('解析失败: ' + (e.message || e));
  }
}
