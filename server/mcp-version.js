// server/mcp-version.js - 我们两个方向都说的 MCP 协议版本（单一出处）
//
// 为什么单独放一处：客户端（server/mcp.js 的 initialize）与服务端（server/mcp-server.js 的回声）
// 必须说同一个版本；写在两处迟早会漂移，而漂移的表现是"连不上/工具面为空"，排查成本远高于一个常量文件。
// 取值依据：我们客户端实际握手用的就是它（且在真机上连通过 GitHub MCP server）。
export const PROTOCOL_VERSION = '2024-11-05';
