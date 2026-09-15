// server/modelcaps.js - §4.3 模型网关「模型能力声明」的**唯一判定实现**（视觉/工具/思考三维）2026-09-17
//
// 为什么要有这个模块（缺口原文，先写清"改造前"的样子）：
//   §4.3 那一行要求模型网关做「**模型能力声明（窗口/工具/视觉/思考）** + 可切云端/客户网关/内网推理 + 断网降级」。
//   改造前的真实状态是**只有字段、没有消费方**：
//     · 字段：`server/llm/providers.js` 每条厂商的 `capabilities: [...]`（视觉是 `vision`、工具是 `tool`、
//       思考是 `reasoning`；另有 `image`=出图、`video`、`ocr`、`code`、`chat`，与这三维不是一回事）；
//       入库：`server/index.js` 把 `p.capabilities` 写进 `models.capabilities`（另见 `llm/providers.js` syncChatModels、
//       `llm/market.js`）；出口：`/api/models` 把厂商的 `capabilities` 原样吐给前端（`providers.js` activeProviders）。
//     · 消费方：**只有"窗口"那一维**（`server/modelwindow.js`，被 `server/agent.js:397` 的折叠阈值用）。
//       三维（工具/视觉/思考）此前**零命中**——`grep capabilities server/` 只命中 provider/market/表列，
//       而 `server/index.js` 的 `VISION_RE`（`/(图片|看图|照片|截图|识别.*图|vision|image)/i`）是**按消息文本猜**的，
//       猜出来的 route 也不看模型声明。
//
// 本模块的立场（与 `modelwindow.js` 同一条）：
//   ① **判定只有一处**：三维的"能不能"全部由 `capabilitiesOf()` 决定，消费方（`llm/gateway.js` 的发送前闸门、
//      `capabilities.js` 的清单）只问它，不各判一次（"同一件事两处各判一次"是本仓库反复踩过的坑）。
//   ② **只读已声明的字段，不发明值**：这里没有阈值、没有默认能力表、不做"按模型名猜"。
//      声明的唯一出处是厂商的 `capabilities` 数组；不知道就是**不知道**（`declared:false`），
//      而不是"大概不支持"——后者会把"没配"变成"禁止"，是静默改变行为。
//   ③ 三态而不是两态（`true` 支持 / `false` 不支持 / `null` 未声明）：
//      缺失时消费方**维持改造前的行为**（视觉：照发；工具：照发；思考：照转），只在清单里如实写"未声明"。
//
// 字段语义（来自 providers.js，逐条核对过，不改动它）：
//   ⚠️ **`capabilities` 数组不是"排他性的能力全集"，它是产品/UI 的功能标签**（`chat/code/reasoning/tool/image/...`
//      混在一起，供 `/api/models` 与前端菜单用）。所以：**标签里没写 ≠ 声明不支持**。
//   2026-09-17 实测（返工原因，别再"顺手"改回去）：deepseek 的标签是 `['chat','code','reasoning']`（没有 'tool'），
//      但我们**一直在用 DeepSeek 调工具**——C1–C5 计量、跨端回放、自检的"write 档会话跑完一轮"全跑在 deepseek 上；
//      ark 同理（`['chat','vision','image','video']` 无 'tool'，也在用工具）。
//      把"缺标签"当"声明不支持"，后果是**悄悄把主力模型的工具面关掉**——最糟的那种静默降级。
//   ⇒ 三维判定有两个来源，且**只有专用字段能产生 `false`**：
//     · 正向提示：`capabilities` 里**有**该标签 ⇒ `true`（尊重既有声明面——标签今天起的就是这个作用）；
//     · 显式否定：专用字段 `capabilitiesDeclared: { vision?, tool?, reasoning? }` 写 `false` ⇒ `false`（**唯一来源**）；
//     · 其余（标签没有 + 专用字段没这一项 / 厂商整条没声明）⇒ `null`＝**未声明**，消费方维持改造前行为。
//   今天**没有任何厂商**用专用字段声明过 `false` ⇒ 三维行为与改造前逐字相同（照发图 / 照发工具面 / 照转思考）。

import { PROVIDERS, findProvider } from './llm/providers.js';

/** §4.3 要的三维。 */
export const CAP_DIMENSIONS = { vision: 'vision', tool: 'tool', reasoning: 'reasoning' };

/**
 * 显式否定声明的**专用字段名**（providers.js 里可选的 `capabilitiesDeclared`）。
 * 为什么必须另起一个字段、而不是复用 `capabilities`：见文件头那段实测——标签数组是产品标签，
 *   拿它当否定就是在**发明声明**，且后果是静默关掉工具面。这个字段名刻意直白（declared＝"我明确声明"），
 *   读到的人不会误以为"没写就是没有"。
 */
export const CAP_OVERRIDE_FIELD = 'capabilitiesDeclared';

/** 三维各自"被消费"的出口（写在这里，改判定的人一眼能看到谁在读它）。 */
export const CAP_CONSUMERS = {
  vision: 'server/llm/gateway.js（发送前闸门：声明不支持图像 ⇒ 发图前拒绝，不等到模型侧失败）',
  tool: 'server/llm/gateway.js（发送前收工具面：声明不支持工具 ⇒ 不把工具面发出去，并如实记一条被收窄）',
  reasoning: 'server/llm/gateway.js（思考增量转发闸门）+ server/capabilities.js（清单如实上报）',
};

/**
 * §4.3「工具」这一维的**逐次上报**事实名（2026-09-17）。
 * 为什么是"塞进 run_end.capabilities.used"而不是新造一个 SSE 事件类型：
 *   `capabilitySummary(ctx, used)` 已经是 run_end 三条路径都会带出去的现成出口（`used` 本来是"这一次用了哪些工具"），
 *   网关按声明收窄工具面时由 `server/agent.js` 把它一并记进去，用户/运维在 run_end 里就能看到
 *   "这次工具面被能力声明收窄了"。新造事件类型要动 `server/index.js` 的事件白名单**和**前端契约
 *   （本轮明令不碰 index.js），而且没必要。
 * 取值刻意带 `cap:` 前缀：一眼能看出它不是工具名（`used` 里的其它项都是真实工具名）。
 * ⚠️ 定义在这里（而不是 capabilities.js）是**结构原因**：`test/capabilities.test.mjs` 有一条锁——
 *   "能力清单模块不得被系统提示/agent 侧引用"（`server/agent.js` 要记这条账，所以常量不能放在清单模块里）。
 */
export const USED_TOOL_FACE_PRUNED = 'cap:tool-face-pruned';

/**
 * 三维能力声明的**唯一判定**。传厂商 id（查内置清单）或直接给厂商对象（夹具/未来动态注册的厂商都用它）。
 *
 * 判定规则（**只有第二条能产生 `false`**）：
 *   ① `capabilities` 数组含该标签 ⇒ `true`（正向提示）；
 *   ② `capabilitiesDeclared`（`CAP_OVERRIDE_FIELD`）里该维写 `false` ⇒ `false`（显式否定，唯一来源）；
 *   ③ 其它 ⇒ `null`（未声明）。⚠️ **"标签数组里没有"绝不等于 `false`**（deepseek/ark 没有 'tool' 标签但一直在用工具）。
 *
 * @param {string|object} provider 厂商 id（如 'ark'）或厂商对象（如 providers.js 里的一项）
 * @param {string} [model] 模型名。**今天不参与判定**（声明是厂商级的），参数在这里是为了：
 *   ① 调用点把"判的是哪个模型"一起说清；② 将来声明细化到模型级时不必改调用点。
 * @returns {{provider:string|null, model:string|null, declared:boolean, uses:string[], negated:string[],
 *            vision:boolean|null, tool:boolean|null, reasoning:boolean|null}}
 *   `declared:false` = 该厂商既没写 `capabilities`、也没写 `capabilitiesDeclared`（或厂商未知）⇒ 三维全 `null`（未声明），
 *   消费方**不得**把 null 当 false。`negated` = 被显式声明为 false 的维（清单里要说清"这是显式否定，不是缺标签"）。
 */
export function capabilitiesOf(provider, model) {
  const p = typeof provider === 'string' ? findProvider(provider) : (provider && typeof provider === 'object' ? provider : null);
  const tags = p && Array.isArray(p.capabilities) ? p.capabilities : [];
  // 专用否定字段：任何异常形状（字符串/数组/数字）都当"没声明"处理——**不猜**（猜错的方向是关掉能力，代价太大）
  const ov = p && p[CAP_OVERRIDE_FIELD] && typeof p[CAP_OVERRIDE_FIELD] === 'object' && !Array.isArray(p[CAP_OVERRIDE_FIELD])
    ? p[CAP_OVERRIDE_FIELD] : {};
  const declared = tags.length > 0 || Object.keys(ov).length > 0;
  const negated = [];
  // 有任意一维取值 ⇒ 出 true/false；一维都没有 ⇒ null（未声明）。**标签只参与"是 true"，从不参与"是 false"。**
  const cap = (name) => {
    if (ov[name] === false) { negated.push(name); return false; }
    if (ov[name] === true) return true;
    return tags.indexOf(name) >= 0 ? true : null;
  };
  return {
    provider: (p && p.id) || (typeof provider === 'string' ? provider : null),
    model: model ? String(model) : null,
    declared,
    uses: [...tags],
    negated,
    vision: cap('vision'),
    tool: cap('tool'),
    reasoning: cap('reasoning'),
  };
}

/**
 * 单维判定：`canDo(caps, 'vision')`。三态**原样**返回（true/false/null），不在这里替换成默认值——
 * 默认值是**消费方**的业务决定（"未声明就照旧"），塞进这里会让两处默认口径漂移。
 * @param {{vision?:boolean|null,tool?:boolean|null,reasoning?:boolean|null}} caps capabilitiesOf 的返回值
 * @param {'vision'|'tool'|'reasoning'} dim
 * @returns {boolean|null}
 */
export function canDo(caps, dim) {
  if (!caps || CAP_DIMENSIONS[dim] === undefined) return null;
  const v = caps[dim];
  return v === true ? true : (v === false ? false : null);
}

/**
 * 这条消息面里**有没有要发给模型看的图**（视觉闸门的判据）。
 * 判的是消息结构（OpenAI 兼容的多模态 part），**不是消息文本**——`server/index.js` 的 `VISION_RE`
 * 按文本猜路由是另一回事（那属于自动路由，本模块不碰、也不替代）。
 * 覆盖两种真实形态：① `content:[{type:'image_url',...}]`（gateway 的 OCR/看图调用、外部渠道）；
 * ② `{type:'image', source:...}`（Anthropic 风格 part，防将来换壳时漏判）。
 * @param {Array} messages
 * @returns {{hasImage:boolean, parts:number}} parts=命中的 part 数（如实计数，供上报/日志）
 */
export function imagesOf(messages) {
  let parts = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    const c = m && m.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== 'object') continue;
      const t = String(part.type || '');
      if (t === 'image_url' || t === 'image' || t === 'input_image') parts++;
    }
  }
  return { hasImage: parts > 0, parts };
}

/**
 * 视觉闸门的**一句话实话**（网关与清单共用同一句，避免两处措辞漂移）。
 * 措辞点名"**显式声明不支持**"：这条错只可能由 `capabilitiesDeclared` 里的显式 `false` 触发，
 *   不是"标签里没写"（那是另一回事，见文件头）。
 * @param {{provider:string|null, model:string|null}} caps
 * @param {number} parts 消息里的图 part 数
 */
export function visionRefusalMessage(caps, parts) {
  const who = (caps && caps.provider ? caps.provider : '未知厂商') + (caps && caps.model ? '(' + caps.model + ')' : '');
  return '拒绝发送：' + who + ' **显式声明不支持图像输入**（' + CAP_OVERRIDE_FIELD + ': { vision: false }），本条消息含 '
    + (Number(parts) || 0) + ' 个图像 part。请在模型菜单里换一个支持视觉的模型（如 ark / dashscope / qianfan / siliconflow），'
    + '或改用 ocr_image / view_image 工具——本平台在发图前就拒绝，不等模型侧报错。';
}

/**
 * 夹具专用的**声明对象构造器**：按显式能力词造一个厂商对象（形状与 providers.js 的项一致）。
 * 为什么要有这条缝：内置清单里**没有一家**用专用字段声明过"不支持"（见文件头），而闸门必须被钉住
 *   "显式否定 ⇒ 真拒发/真收窄"——夹具若去改动 `PROVIDERS`（增删条目）会污染同一进程里的其它夹具，
 *   所以这里给一个显式、无副作用、只带判定所需字段的构造器。
 * ⚠️ 只给夹具用：生产路径的厂商一律来自 `server/llm/providers.js`（本函数不改那个数组，也不注册任何东西）。
 * @param {string} id
 * @param {string[]|null} uses null＝**没写 capabilities 标签字段**（未声明）
 * @param {object} [extra] 其它字段（base/keyEnv/defaultModel…，**显式否定用 extra 传 `capabilitiesDeclared`**）
 */
export function providerLike(id, uses, extra = {}) {
  const p = { id: String(id), ...extra };
  if (uses !== null && uses !== undefined) p.capabilities = [...uses];
  return p;
}

/**
 * 清单里三维的那几行（人读的：这一维**判了什么**、声明**从哪来**）。
 * `declaredIn` 必须分清两个来源：显式否定只有专用字段能给（`capabilitiesDeclared`），
 *   正向支持可以来自标签数组——"没写"与"写了 false"在清单上必须一眼可分（这正是本次返工的核心）。
 * @param {object} caps capabilitiesOf 的返回值
 */
export function capabilitiesReport(caps) {
  const row = (dim, what) => {
    const v = canDo(caps, dim);
    const negatedHere = !!(caps && Array.isArray(caps.negated) && caps.negated.indexOf(dim) >= 0);
    const fromTags = !!(caps && Array.isArray(caps.uses) && caps.uses.indexOf(dim) >= 0);
    const note = negatedHere || v === false
      ? ('模型**显式声明不支持**（' + CAP_OVERRIDE_FIELD + ' 里写了 false）：' + what + '——消费方据此拒发/收窄（见 CAP_CONSUMERS）')
      : v === true
        ? ('模型声明支持：' + what + (fromTags ? '（来自 capabilities 标签）' : '（来自专用字段 capabilitiesDeclared 的显式 true）'))
        : ('能力**未声明**：' + what + '——按改造前行为处理，不因缺声明就禁止'
          + '（注意：capabilities 标签里没有这一项**不算**不支持，见本文件"字段语义"）');
    return {
      dimension: dim, supports: v,
      declaredIn: (negatedHere || v === false) ? CAP_OVERRIDE_FIELD : (fromTags ? 'provider.capabilities（标签，仅作正向提示）' : null),
      note,
    };
  };
  return [
    row('vision', '接受图像输入（图 part 会被发到模型）'),
    row('tool', '函数调用/工具面（tools 字段会被发出去）'),
    row('reasoning', '思考/推理增量（reasoning_content 会被转发到界面）'),
  ];
}
