-- D3 usage 实时可视化视图（幂等：CREATE OR REPLACE VIEW，可随时重跑）
-- 已在本机库执行；如需重建：node /srv/rw-workspace/mkviews.mjs（或直接粘贴执行）

-- 1) 按天×厂商×模型汇总：请求数/输入输出/cache hit·miss/成本/命中率
CREATE OR REPLACE VIEW v_usage_daily AS
SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS d, provider_id, model_id, COUNT(*) AS reqs,
  SUM(tokens_in) AS tok_in, SUM(tokens_out) AS tok_out, SUM(cache_hit_tokens) AS hit, SUM(cache_miss_tokens) AS miss,
  SUM(cost) AS cost, ROUND(100*SUM(cache_hit_tokens)/NULLIF(SUM(cache_hit_tokens)+SUM(cache_miss_tokens),0),1) AS hit_rate_pct
FROM usage_stats GROUP BY d, provider_id, model_id;

-- 2) 按小时×会话×kind 看每轮成本（找"哪轮贵"）
CREATE OR REPLACE VIEW v_usage_by_round AS
SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS d, DATE_FORMAT(created_at,'%H:00') AS h, conversation_id, kind, provider_id, model_id,
  COUNT(*) AS rounds, SUM(tokens_in) AS tok_in, SUM(tokens_out) AS tok_out, SUM(cache_hit_tokens) AS hit, SUM(cache_miss_tokens) AS miss, SUM(cost) AS cost
FROM usage_stats GROUP BY d, h, conversation_id, kind, provider_id, model_id;

-- 3) 按会话×模型×kind 找"哪个会话烧钱"
CREATE OR REPLACE VIEW v_usage_by_conversation AS
SELECT conversation_id, provider_id, model_id, kind, COUNT(*) AS rounds,
  SUM(tokens_in) AS tok_in, SUM(tokens_out) AS tok_out, SUM(cache_hit_tokens) AS hit, SUM(cache_miss_tokens) AS miss, SUM(cost) AS cost
FROM usage_stats GROUP BY conversation_id, provider_id, model_id, kind;

-- 查"今天每轮命中率与成本 TOP"示例：
-- SELECT d,h,conversation_id,kind,rounds,hit_rate 需自算；直接：
-- SELECT * FROM v_usage_by_round WHERE d=CURDATE() ORDER BY cost DESC LIMIT 20;
