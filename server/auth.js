// server/auth.js - 登录 / 会话 / 邀请码
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { config } from './config.js';

export function hashPwd(p) { return bcrypt.hashSync(p, 10); }
export function checkPwd(p, h) { return bcrypt.compareSync(p, h); }
export function newToken() { return crypto.randomBytes(24).toString('hex'); }

// 初始化内置管理员（.env 的 RW_ADMIN_USER / RW_ADMIN_PASS）
export async function ensureAdmin() {
  const { user, pass } = config.admin;
  if (!user || !pass) return;
  const rows = await db.query('SELECT id FROM accounts WHERE username=?', [user]);
  if (rows.length === 0) {
    await db.query('INSERT INTO accounts (username, pass_hash, role, created_at) VALUES (?,?,?,NOW())', [user, hashPwd(pass), 'admin']);
    console.log('[auth] 管理员已初始化:', user);
  }
}

export async function login(username, password) {
  const rows = await db.query('SELECT id, username, pass_hash, role FROM accounts WHERE username=?', [username]);
  if (!rows.length) throw new Error('账号不存在');
  const a = rows[0];
  if (!checkPwd(password, a.pass_hash)) throw new Error('密码错误');
  const token = newToken();
  await db.query(
    'INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?,?,NOW(),DATE_ADD(NOW(), INTERVAL ? DAY))',
    [token, a.id, config.session.days]
  );
  return { token, user: { id: a.id, username: a.username, role: a.role } };
}

export async function me(token) {
  if (!token) return null;
  const rows = await db.query(
    `SELECT a.id, a.username, a.role FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token=? AND s.expires_at > NOW()`,
    [token]
  );
  return rows[0] || null;
}

export async function logout(token) {
  await db.query('DELETE FROM sessions WHERE token=?', [token]);
}

export async function createInvite(accountId) {
  const code = crypto.randomBytes(4).toString('hex');
  await db.query('INSERT INTO invites (code, created_by) VALUES (?,?)', [code, accountId]);
  return code;
}

export async function registerWithInvite(username, password, code) {
  const rows = await db.query('SELECT code FROM invites WHERE code=? AND used_by IS NULL', [code]);
  if (!rows.length) throw new Error('邀请码无效或已使用');
  const exists = await db.query('SELECT id FROM accounts WHERE username=?', [username]);
  if (exists.length) throw new Error('用户名已存在');
  const r = await db.query('INSERT INTO accounts (username, pass_hash, role) VALUES (?,?,?)', [username, hashPwd(password), 'user']);
  await db.query('UPDATE invites SET used_by=?, used_at=NOW() WHERE code=?', [r.insertId, code]);
  return true;
}

// Express 中间件：校验 Bearer token
export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ ok: false, message: '未登录' });
  me(token).then((u) => {
    if (!u) return res.status(401).json({ ok: false, message: '登录已过期' });
    req.user = u;
    req.token = token;
    next();
  }).catch(() => res.status(500).json({ ok: false, message: '鉴权失败' }));
}
