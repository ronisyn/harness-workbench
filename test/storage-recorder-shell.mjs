// test/storage-recorder-shell.mjs —— 夹具用的**记账假存储**（`node --import <本文件> server/index.js` 起真服务时预载）
//
// 为什么要有它：G1 的判据是"干净机器跑通一轮"，而"跑通"**不能**证明"这条链真的走存储接口"——
// 数据落在 JSON 文件里只说明"至少有一条路径写进去了"。真正要钉住的是这句：
// **链上的每一次读写都经过接口**；只要有一处绕过（例如某模块 import 期自己 `db.query`），
// 换实现时就有一半留在原地，而"一轮跑得通"照样是绿的（这正是上一轮"半迁移"的来源）。
//
// 做法（机制性断言，不是读源码猜）：进程启动时把 `server/storage/index.js` 导出的那个**接口对象**逐方法包一层，
// 每次调用记一行（`实体.方法`），再**原样转发给真实现**。
//   · 为什么是"转发"而不是另写一个内存假实现：接口面有 60+ 个方法，另写一份必然与真实现长歪，
//     夹具就会开始测"那个替身"而不是"这条链到底经不经过接口"。转发 ⇒ 语义零偏差，只有观测被加上。
//   · 为什么能包住：`server/index.js` 第 60 行 `import { storage } from './storage/index.js'` 拿的是
//     **同一个模块实例**（ESM 按 URL 缓存），本文件先求值、就地替换方法属性，之后所有调用方看到的都是包装版。
//   · 观测面**只记方法名与少量非敏感标量**（会话/账号 id、role 之类）：`accounts.create` 的入参里有口令哈希，
//     一概不进日志。这不是"顺手记全"，是必须的最小面。
//
// 这个文件与 `offline-model-shell.mjs` 同属**夹具专用预载**（不是产品代码，不参与 `node --test` 收集）。
import fs from 'node:fs';

const LOG = process.env.RW_STORAGE_CALL_LOG || '';
const line = (s) => { if (LOG) { try { fs.appendFileSync(LOG, s + '\n'); } catch { /* 观测失败不影响服务 */ } } };

const { storage } = await import('../server/storage/index.js');

/** 只挑几个**非敏感**标量进日志：够用来判"这次写落在哪个会话/账号上"，又不会把口令哈希/正文写进去。 */
const HINTS = ['conversationId', 'accountId', 'role', 'toolName', 'type', 'key', 'state'];
const hintOf = (a) => {
  const o = a[0];
  if (!o || typeof o !== 'object') return '';
  const parts = [];
  for (const k of HINTS) {
    if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'object') parts.push(k + '=' + String(o[k]).slice(0, 40));
  }
  return parts.length ? ' ' + parts.join(' ') : '';
};

let wrapped = 0;
for (const [entity, verbs] of Object.entries(storage)) {
  if (!verbs || typeof verbs !== 'object') continue;
  for (const [verb, fn] of Object.entries(verbs)) {
    if (typeof fn !== 'function') continue;
    storage[entity][verb] = function (...a) {
      line(entity + '.' + verb + hintOf(a));
      return fn.apply(this, a);
    };
    wrapped += 1;
  }
}
line('#recorder 已包 ' + wrapped + ' 个接口方法（实现=' + storage.impl + '）');
