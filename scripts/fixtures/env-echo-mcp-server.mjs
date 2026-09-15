// scripts/fixtures/env-echo-mcp-server.mjs —— 夹具：把**父进程给它的环境变量**回显出来的最小 MCP server
// 用途（C-18）：验证"MCP 连接真的拿到了凭据文档里的值"，以及"日志/返回值里没有明文"。
//   tool `env`  : 回显参数里指定的环境变量（缺失时返回 MISSING，而不是空串——空串会让"没给"与"给了空"分不清）
//   stdout 噪音 : 把同样的值写到 stdout/stderr（模拟"外部程序把密钥回显出来"这条真实泄漏路径）
//   --leak-via-stdout : 未经 tools/call 就主动把值喷到 stderr（更接近真实事故）
//
// ⚠️ 这个文件**不能**放 `test/` 下：`node --test` 会把 test/**.mjs 全当测试文件跑，
//    而它是个"等 stdin 说话"的常驻进程，会把整套测试永久挂住（fake-mcp-server.mjs 踩过这个坑）。
const NAME = process.argv[2] || 'GITHUB_PERSONAL_ACCESS_TOKEN';
const LEAK = process.argv.includes('--leak-via-stdout');

const TOOLS = [
  { name: 'env', description: '回显指定环境变量', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
];

// 启动先声明一句"我起来了"（stderr ⇒ 父进程的 [mcp:*] 日志）。它同时是两件事的支点：
//   ① 夹具能断言"mcp 日志确实产生了"（否则"日志里没有明文"这条断言是空的）；
//   ② --leak-via-stdout 时把值顺带喷出来，模拟"外部程序自己把密钥回显出去"这条真实泄漏路径。
process.stderr.write('env-echo 已启动' + (LEAK ? ' startup-dump ' + NAME + '=' + (process.env[NAME] || 'MISSING') : '') + '\n');

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
    if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'env-echo', version: '1' }, capabilities: { tools: {} } });
    else if (msg.method === 'tools/list') reply({ tools: TOOLS });
    else if (msg.method === 'tools/call') {
      const a = msg.params || {};
      if (a.name === 'env') {
        const which = (a.arguments || {}).name || NAME;
        const val = process.env[which] === undefined ? 'MISSING' : process.env[which];
        if (val !== 'MISSING') process.stdout.write('noise ' + which + '=' + val + '\n'); // 故意往 stdout 喷噪音（JSON-RPC 会忽略非 JSON 行）
        reply({ content: [{ type: 'text', text: which + '=' + val }] });
      } else reply({ content: [{ type: 'text', text: 'called:' + a.name }] });
    } else reply({});
  }
});
process.stdin.on('end', () => process.exit(0));
