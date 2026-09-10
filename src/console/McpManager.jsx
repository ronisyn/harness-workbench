// src/console/McpManager.jsx - MCP 外部工具接入（P11；A8 起从设置页迁至扩展中心——§8.8"设置页不再混 MCP"）
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function McpManager() {
  const [text, setText] = useState('[]');
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setText(JSON.stringify((s.settings?.mcp_servers || []), null, 2));
      const m = await api.mcpStatus();
      setStatus('已配置 ' + (m.configured || []).length + ' 个 server；已连接 ' + (m.clients || []).length + ' 个：' + (m.clients || []).map((c) => c.id).join(', '));
    } catch (e) { setErr('MCP 查询失败：' + (e.message || e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const save = async () => {
    let parsed = [];
    try { parsed = JSON.parse(text || '[]'); if (!Array.isArray(parsed)) throw new Error('需为数组'); }
    catch (e) { setErr('MCP 配置格式错误：' + e.message); return; }
    setErr('');
    try {
      await api.setSettings({ mcp_servers: parsed });
      const r = await api.mcpReload();
      setStatus('已保存并重连：' + (r.results || []).map((x) => (x.ok ? '✅' : '❌') + x.id).join(' ') + '；注册工具 ' + (r.registeredTools || 0) + ' 个');
      try { await api.extensionMcpSync(); } catch { /* 资产化同步失败不阻断 */ }
    } catch (e) { setErr('保存失败：' + e.message); }
  };
  return (
    <div className="rw-cap-group" style={{ marginTop: 18 }}>
      <div className="rw-cap-gtitle">MCP 外部服务接入（连接后工具以 mcp_&lt;serverId&gt;_&lt;tool&gt; 提供给模型；按壳装载见上方资产卡）</div>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>{`配置格式（数组）：[ { id, command, args: [], env: { KEY: 值 } } ]。示例（GitHub MCP server）：
[ { "id": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "你的token" } } ]`}</div>
      <textarea className="rw-input" rows="8" style={{ fontFamily: 'monospace', fontSize: 12, width: '100%', boxSizing: 'border-box' }}
        value={text} onChange={(e) => setText(e.target.value)} placeholder='[]' />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button className="rw-btn" onClick={save}>保存并连接</button>
        <button className="rw-btn" onClick={() => api.extensionMcpSync().then((r) => setStatus('MCP 资产化同步：' + r.synced + ' 个')).catch((e) => setErr(e.message))}>同步为资产</button>
        {err && <span className="rw-kb-err" style={{ margin: 0 }}>{err}</span>}
      </div>
      {status && <div style={{ marginTop: 8, fontSize: 12 }}>{status}</div>}
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>密钥字段（键名含 token/key/secret/password）页面显示 <code>__REDACTED__</code> 占位，不明文下发——直接保存即保留服务器原值。⚠️ 外部 MCP=不可信输入：提示注入防线触发条件见方案 §11.4。</div>
    </div>
  );
}
