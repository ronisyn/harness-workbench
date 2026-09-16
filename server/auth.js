// server/auth.js - 登录 / 会话 / 邀请码
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { config } from './config.js';
import { storage } from './storage/index.js'; // v0.3 §4.1「存储走接口」：登录链走接口，不再直接发 SQL

export function hashPwd(p) { return bcrypt.hashSync(p, 10); }
export function checkPwd(p, h) { return bcrypt.compareSync(p, h); }
export function newToken() { return crypto.randomBytes(24).toString('hex'); }

// 初始化内置管理员（.env 的 RW_ADMIN_USER / RW_ADMIN_PASS）
export async function ensureAdmin() {
  const { user, pass } = config.admin;
  if (!user || !pass) return;
  const exist = await storage.accounts.findByUsername(user);
  if (!exist) {
    await storage.accounts.create({ username: user, passHash: hashPwd(pass), role: 'admin' });
    console.log('[auth] 管理员已初始化:', user);
  }
}

export async function login(username, password) {
  const a = await storage.accounts.findByUsername(username);
  if (!a) throw new Error('账号不存在');
  if (!checkPwd(password, a.passHash)) throw new Error('密码错误');
  const token = newToken();
  await storage.sessions.create({ token, accountId: a.id, days: config.session.days });
  return { token, user: { id: a.id, username: a.username, role: a.role } };
}

export async function me(token) {
  if (!token) return null;
  return storage.sessions.findValid(token);
}

export async function logout(token) {
  await storage.sessions.remove(token);
}

// 邀请码（`invites` 表）：**未迁**——`invites` 不在存储接口的实体清单里，且这两个函数全仓零调用方
// （只有本文件导出，`server/index.js` 没有注册端点）。本轮按"只碰必须碰的"原样留着走 `db`，
// 待 `invites` 进接口时一起迁（已登记在迁移清单里，不是漏掉）。
export async function createInvite(accountId) {
  const code = crypto.randomBytes(4).toString('hex');
  await db.query('INSERT INTO invites (code, created_by) VALUES (?,?)', [code, accountId]);
  return code;
}

export async function registerWithInvite(username, password, code) {
  // 邀请码那两条仍是 `db`（`invites` 不在存储接口的实体清单里，两个函数全仓零调用方）；**账号那两条走接口**
  // ——账号是登录链的实体，留着直连就等于"这条链还剩一处连库"，jsonfile 实现下注册会半途失败。
  const rows = await db.query('SELECT code FROM invites WHERE code=? AND used_by IS NULL', [code]);
  if (!rows.length) throw new Error('邀请码无效或已使用');
  const exists = await storage.accounts.findByUsername(username);
  if (exists) throw new Error('用户名已存在');
  const r = await storage.accounts.create({ username, passHash: hashPwd(password), role: 'user' });
  await db.query('UPDATE invites SET used_by=?, used_at=NOW() WHERE code=?', [r.id, code]);
  return true;
}

// Express 中间件：校验 Bearer token
// D4-2：错误响应带机器可读 `code`（契约 docs/会话API契约-v1.md §5）。401 分两种，调用方要能分辨
// "没带凭证"（去登录）与"凭证过期"（重新登录）——正是《接口规范》§三 说的"客户端要分别处理"。
export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '未登录' });
  me(token).then((u) => {
    if (!u) return res.status(401).json({ ok: false, code: 'TOKEN_EXPIRED', message: '登录已过期' });
    req.user = u;
    req.token = token;
    next();
  }).catch(() => res.status(500).json({ ok: false, code: 'INTERNAL', message: '鉴权失败' }));
}
