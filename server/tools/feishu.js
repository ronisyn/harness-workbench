// server/tools/feishu.js - 飞书文档能力（F7 云文档 / F9 知识库 / F10 表格 / F11 多维表格）
// 通过飞书开放平台 API 读取文档内容，供 Agent 分析
// 界限：不再各自写超时字面量（AbortSignal.timeout）——外部调用一律消费**调用级 signal**
// （由 execTool 按工具定义上声明的 `timeoutMs` 派生，见 tools/deadline.js）：一个界限只有一个出处，
// 且用户"停止"能真正打断在飞的请求（原来各自写死超时，停止按钮对这些调用无效）。
const FEISHU_API = 'https://open.feishu.cn/open-apis';
let tokenCache = { token: '', expireAt: 0 };

export function feishuConfigured() {
  return Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
}

export async function getToken(signal) {
  if (tokenCache.token && Date.now() < tokenCache.expireAt) return tokenCache.token;
  const res = await fetch(FEISHU_API + '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
    signal,
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error('飞书 token 获取失败: ' + (j.msg || j.code));
  tokenCache = { token: j.tenant_access_token, expireAt: Date.now() + (j.expire || 7200) * 1000 - 60000 };
  return tokenCache.token;
}

async function feishuGet(path, signal) {
  const token = await getToken(signal);
  const res = await fetch(FEISHU_API + path, { headers: { Authorization: 'Bearer ' + token }, signal });
  const j = await res.json();
  if (j.code !== 0) throw new Error('飞书 API 错误: ' + (j.msg || j.code));
  return j.data;
}

// 从链接/输入解析 docx / wiki token
function parseToken(input) {
  const s = String(input || '');
  const docx = s.match(/docx\/([A-Za-z0-9]+)/);
  if (docx) return { type: 'docx', id: docx[1] };
  const wiki = s.match(/wiki\/([A-Za-z0-9]+)/);
  if (wiki) return { type: 'wiki', id: wiki[1] };
  const sheet = s.match(/sheets\/([A-Za-z0-9]+)/);
  if (sheet) return { type: 'sheet', id: sheet[1] };
  if (/^[A-Za-z0-9]{20,}$/.test(s)) return { type: 'docx', id: s };
  return null;
}

// 读取飞书云文档（docx）raw_content（markdown）
export async function readFeishuDoc(input, signal) {
  const t = parseToken(input);
  if (!t) throw new Error('无法识别的飞书链接/ID');
  if (t.type === 'wiki') {
    const node = await feishuGet('/wiki/v2/spaces/get_node?token=' + t.id, signal);
    const objToken = node?.node?.obj_token;
    if (!objToken) throw new Error('wiki 节点无文档');
    const d = await feishuGet('/docx/v1/documents/' + objToken + '/raw_content', signal);
    return { type: 'wiki', title: node.node?.title || '', content: d.content || '' };
  }
  const d = await feishuGet('/docx/v1/documents/' + t.id + '/raw_content', signal);
  return { type: 'docx', title: d.document?.title || '', content: d.content || '' };
}

// 读取飞书电子表格
export async function readFeishuSheet(input, range, signal) {
  const t = parseToken(input);
  if (!t || t.type !== 'sheet') throw new Error('需要飞书表格链接');
  const data = await feishuGet('/sheets/v3/spreadsheets/' + t.id + '/sheets/query', signal);
  const sheet = data?.sheets?.[0];
  if (!sheet) throw new Error('表格无工作表');
  const sheetId = sheet.sheet_id;
  const rng = range || sheet.title + '!A1:Z50';
  const d = await feishuGet(`/sheets/v2/spreadsheets/${t.id}/values/${encodeURIComponent(rng)}`, signal);
  const values = d?.valueRange?.values || [];
  return { title: sheet.title, rows: values.slice(0, 100) };
}

// 读取飞书多维表格（Bitable）
export async function readFeishuBitable(appToken, tableId, signal) {
  const d = await feishuGet(`/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=50`, signal);
  const items = (d?.items || []).map((r) => {
    const fields = r.fields || {};
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? (x.text || x.name || JSON.stringify(x)) : x)).join(', ') : String(v ?? '');
    }
    return out;
  });
  return { count: items.length, records: items };
}
