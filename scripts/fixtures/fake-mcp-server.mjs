// scripts/fixtures/fake-mcp-server.mjs —— 夹具：一个最小的 MCP server（JSON-RPC over stdio）
// 用途：MCP 这条链路在真实部署里只有"配了 server 才有流量"，靠单测打不到端到端；
// 用它把 **真实 spawn → 握手 → 分页 tools/list → tools/call** 整条链路跑通，含两个故意做坏的分页：
//   --bad-cursor : 每一页都返回同一个游标（分页坏了）。正确实现必须**报错**，而不是死循环或悄悄少给工具。
//   --multi-page : 两页工具（默认行为），验证 nextCursor 被跟随、第二页的工具不会丢。
//
// ⚠️ 这个文件**不能**放在 `test/` 下：`node --test` 的默认发现规则把 `test/**/*.mjs` 全当测试文件，
//    于是这个"等着 stdin 说话"的 server 会被当测试跑起来并**永久挂住整套测试**（本地实测：600s 超时无输出）。
const BAD_CURSOR = process.argv.includes('--bad-cursor');

const TOOLS = [
  { name: 'echo', description: '原样回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'second_page_tool', description: '只在第二页出现的工具', inputSchema: { type: 'object', properties: {} } },
];

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method && msg.method.startsWith('notifications/')) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '1' }, capabilities: { tools: {} } });
    else if (msg.method === 'tools/list') {
      if (BAD_CURSOR) reply({ tools: [TOOLS[0]], nextCursor: 'same-forever' });       // 永远给同一个游标
      else if (!msg.params || !msg.params.cursor) reply({ tools: [TOOLS[0]], nextCursor: 'page2' });
      else if (msg.params.cursor === 'page2') reply({ tools: [TOOLS[1]] });           // 第二页，无 nextCursor
      else reply({ tools: [] });
    } else if (msg.method === 'tools/call') {
      const a = msg.params || {};
      if (a.name === 'echo') reply({ content: [{ type: 'text', text: 'echo:' + String((a.arguments || {}).text) }] });
      else reply({ content: [{ type: 'text', text: 'called:' + a.name }] });
    } else reply({});
  }
});
process.stdin.on('end', () => process.exit(0));
