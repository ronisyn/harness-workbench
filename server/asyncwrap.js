// server/asyncwrap.js - 给 Express 4 的 async 处理器补上 rejection 兜底（Express 5 原生支持，我们钉在 4 上）
//
// 2026-09-16（Windows 端到端实测撞出来的真问题）：任一 async 处理器里 await 抛错时，
// **Express 4 不会把它交给错误中间件**（只有人显式 `next(err)` 才走那条路），后果是客户端**永久挂住**：
// 实测 `POST /api/conversations` 遇到 `Unknown column 'provider'`（全新库缺列）时，服务端只留下一行
// unhandledRejection 日志，客户端要等自己 240 秒的超时才放弃，而这期间没有任何 500、没有可诊断的响应。
//
// 与其给一百多个路由逐个包 try/catch（漏一个就白做，且以后新加路由还得记得包），不如在装配完成后统一包一层。
// 放进独立模块而不是塞在 index.js 里：index.js 一 import 就会启动整个应用（连库、监听端口），
// 夹具没法单独验证这个函数——它的正确性恰恰值得单独钉住。
//
// 口径：只包"普通处理器"（形参 4 个的是错误中间件，包了会改变它的语义）；包过的打标记，重复调用不会套两层。
export function wrapAsyncHandlers(app) {
  let n = 0;
  for (const layer of (app._router && app._router.stack) || []) {
    if (!layer.route || !Array.isArray(layer.route.stack)) continue;
    for (const l of layer.route.stack) {
      const h = l.handle;
      if (typeof h !== 'function' || h.length >= 4 || h.__rwAsyncWrapped) continue;
      l.handle = function rwAsyncWrapped(req, res, next) {
        try {
          const r = h.call(this, req, res, next);
          if (r && typeof r.then === 'function') r.catch(next);
        } catch (e) { next(e); }
      };
      l.handle.__rwAsyncWrapped = true;
      n++;
    }
  }
  return n;
}
