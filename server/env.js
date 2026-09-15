// server/env.js - 环境事实的单一来源（部署时确定，不随会话变化）
// 目的：引擎代码里不再出现平台专属字面量（路径/服务名/搜索后端），换环境只改环境变量。
// 口径：默认值＝现行部署值（行为不变）；本模块**只收环境事实**，不收行为规则与业务配置。
// 依据：《RW-Agent 架构 v1.1》§3.1（环境无关）；验收 G1 / RA-01。
import path from 'node:path';

export const RW_PLATFORM_DIR = process.env.RW_PLATFORM_DIR || '/srv/harness-workbench'; // 平台代码目录
export const RW_WORKSPACE = process.env.RW_WORKSPACE || '/srv/rw-workspace';            // Agent 工作区
export const RW_SKILLS = process.env.RW_SKILLS || path.join(RW_WORKSPACE, 'skills');     // 技能根目录
export const RW_SERVICE = process.env.RW_SERVICE || 'rw-test';                           // 服务名（重启/自愈用）
export const RW_SEARCH_ENGINE = process.env.RW_SEARCH_ENGINE || 'SearXNG';               // 联网搜索后端名
