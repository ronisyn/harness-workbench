// src/console/AgentWizard.jsx - A2 §8.9 Agent 装配向导（9 步 step0-8：壳模板/身份/人格领域/工具面/模型策略/技能/知识与扩展/护栏对外/验收）
// 产出 pack → import（壳 upsert）→ 装载扩展（shell_extensions）→ 金标 canary 冒烟（变更即跑）。伪配置防护：仅接线字段可编辑，其余标"即将支持"。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

const PRESET_LB = { minimal: '精简(基础)', standard: '标准(基础+专业)', all: '全量(基础+专业+高危)' };
const TIER_CN = { core: '基础', pro: '专业', expert: '高危' };
const PERSONA_EXAMPLES = [
  { t: '身份型', s: '你是供应链资深计划员，专业简洁，建议必带数据依据与风险' },
  { t: '风格型', s: '写作教练，启发提问，不代写结论' },
  { t: '约束型', s: '只依本壳知识作答，不编造' },
  { t: '立场型', s: '先结论后理由，主动指出缺陷' },
];
const DOMAIN_EXAMPLES = [
  { t: '供应链壳', s: '术语 SKU/LT/备货周期，数据源=本壳知识库备货表，只做计划建议不下采购单' },
  { t: '代码壳', s: '服务代码开发：仓库操作、测试、部署前自检' },
  { t: '知识创作壳', s: '读书笔记/课件大纲/写作支持，术语与边界按领域自定' },
];

const packBase = {
  shellPackVersion: 1,
  key: '', name: '', description: '',
  identity: { persona: '', tone: '', forbidden: [] },
  domain: { agendsText: '', terms: [] },
  modelPolicy: { defaultProvider: '', defaultModel: '', allowModels: [], budgetYuan: 0, qualityCostBias: null },
  tools: { presetBase: 'standard', forceOn: [], forceOff: [], mcps: [], connectors: [] },
  knowledge: { scopes: ['global'], importRefs: [] },
  skills: { allow: [], defaultsAutoLoad: [] },
  guardrails: { accessRules: [], approvalMode: 'default', sensitiveDefaults: [] },
  channels: { domainHosts: [], bindings: {} },
  eval: { goldenSetRef: null },
  intentRules: null,
  taskProfiles: null,
};

export default function AgentWizard({ initial, onClose, onDone }) {
  // initial：编辑既有壳 → GET export 的 pack；新建 → null（step0 起）
  const [step, setStep] = useState(0);
  const [tpls, setTpls] = useState([]);          // step0 壳模板列表
  const [tools, setTools] = useState([]);        // step3 全工具（分级/中文）
  const [skills, setSkills] = useState([]);      // step5 技能列表
  const [exts, setExts] = useState([]);          // step6 扩展资产（plugin/mcp/app）
  const [providers, setProviders] = useState([]);
  const [pack, setPack] = useState(null);        // 当前草稿 pack
  const [extSel, setExtSel] = useState([]);      // step6 勾选的扩展 {type,key}
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);    // 建壳结果 + canary

  useEffect(() => {
    if (initial) { setPack(initial); }
    else { setPack(JSON.parse(JSON.stringify(packBase))); }
    api.templates && fetch('/api/shell-templates').then((r) => r.json()).then((d) => setTpls(d.templates || [])).catch(() => {});
    api.getToolset().then((d) => setTools(d.tools || [])).catch(() => {});
    api.skillsList().then((d) => setSkills(d.skills || [])).catch(() => {});
    api.extensions().then((d) => setExts(d.extensions || [])).catch(() => {});
    api.providers().then((d) => setProviders((d.providers || []).filter((p) => p.connected))).catch(() => {});
  }, [initial]);

  const setP = useCallback((fn) => setPack((p) => fn(p ? JSON.parse(JSON.stringify(p)) : JSON.parse(JSON.stringify(packBase)))), []);

  // step0：选壳模板预填
  const applyTpl = (t) => {
    setP((p) => {
      p.identity.persona = t.persona || '';
      p.domain.agendsText = t.domainText || '';
      p.tools.presetBase = t.presetBase || 'standard';
      p.tools.forceOn = t.forceOn || [];
      p.tools.forceOff = t.forceOff || [];
      p.skills.allow = t.skills || [];
      return p;
    });
    setStep(1);
  };

  const stepTitles = [
    '0 壳模板', '1 身份', '2 人格与领域', '3 工具面', '4 模型策略', '5 技能', '6 知识与扩展', '7 护栏与对外', '8 验收',
  ];

  const canNext = () => {
    if (step === 1) return /^[a-z0-9][a-z0-9-]{0,31}$/.test(pack.key || '') && (pack.name || '').trim();
    return true;
  };

  const buildShellExt = () => extSel; // step6 勾选；建壳后 PUT

  const doCreate = async () => {
    setBusy(true); setErr(''); setMsg(''); setResult(null);
    try {
      const r = await api.shellImport(pack);
      setMsg('✅ 壳已保存：' + r.key + '（' + (r.mode === 'updated' ? '更新' : '新建') + '）');
      // 装载扩展（step6 勾选）
      try {
        const chosen = buildShellExt();
        if (chosen.length) await api.setShellExtensions(r.key, chosen);
      } catch (e) { setErr('扩展装载失败：' + e.message); }
      // 金标 canary：变更即跑（装配冒烟接金标；无金标集则 skipped 正常）
      let canary = null;
      try { canary = await api.shellCanary(r.key); } catch { canary = null; }
      setResult({ shellKey: r.key, canary });
    } catch (e) { setErr('建壳失败：' + e.message); }
    finally { setBusy(false); }
  };

  // —— step3 工具三态 ——
  const toolMode = (name) => {
    const t = pack.tools;
    if ((t.forceOff || []).includes(name)) return 'off';
    if ((t.forceOn || []).includes(name)) return 'on';
    return 'follow';
  };
  const setToolMode = (name, mode) => {
    setP((p) => {
      const on = new Set(p.tools.forceOn || []); const off = new Set(p.tools.forceOff || []);
      on.delete(name); off.delete(name);
      if (mode === 'on') on.add(name);
      else if (mode === 'off') off.add(name);
      p.tools.forceOn = [...on].sort();
      p.tools.forceOff = [...off].sort();
      return p;
    });
  };
  // 按档一键填（常用预设）
  const quickPreset = (which) => {
    setP((p) => {
      if (which === 'dev') { p.tools.presetBase = 'standard'; p.tools.forceOff = ['run_command']; p.tools.forceOn = []; }
      else if (which === 'research') { p.tools.presetBase = 'standard'; p.tools.forceOn = ['web_search', 'fetch_url']; p.tools.forceOff = []; }
      else if (which === 'safe') { p.tools.presetBase = 'minimal'; p.tools.forceOff = ['run_command', 'delete_file', 'db_write', 'git_pull_push']; p.tools.forceOn = []; }
      return p;
    });
  };

  // —— step6 扩展勾选 ——
  const extChecked = (type, key) => extSel.some((e) => e.type === type && e.key === key);
  const toggleExt = (type, key) => setExtSel((o) => extChecked(type, key) ? o.filter((e) => !(e.type === type && e.key === key)) : [...o, { type, key }]);

  const mpModels = providers.find((p) => p.provider_key === pack.modelPolicy.defaultProvider)?.models || [];

  const input = (label, value, onChange, opts = {}) => (
    <div className="rw-cap-item col">
      <span>{label}</span>
      {opts.textarea
        ? <textarea className="rw-input" rows={opts.rows || 2} value={value} onChange={(e) => onChange(e.target.value)} />
        : <input className="rw-input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={opts.ph || ''} />}
    </div>
  );

  return (
    <div className="rw-provider" style={{ marginBottom: 16 }}>
      <div className="rw-dash-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>🧩 Agent 装配向导{initial ? ' · 编辑 ' + initial.key : ' · 新建'}</span>
        <span>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => <span key={i} className={'rw-provider-model' + (i === step ? ' on' : i < step ? '' : ' dim')} style={{ cursor: 'default' }}>{stepTitles[i]}</span>)}
        </span>
      </div>
      <div className="rw-dash-muted" style={{ marginBottom: 8 }}>向导=按壳身份装配（§8.9）；保存走 pack 全量导入（upsert），装载扩展随 step6，建壳后自动跑金标 canary。</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}

      {/* step0 壳模板 */}
      {step === 0 && (
        <div>
          <div className="rw-cap-gtitle">选择壳模板（预填 persona/领域/工具三态/技能，可再改；或自建空壳）</div>
          <div className="rw-dash-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
            {(tpls.length ? tpls : [{ key: 'blank', name: '自建（空壳起步）', hint: '手填身份/人格/领域，不预填' }]).map((t) => (
              <div key={t.key} className="rw-dash-card" style={{ cursor: 'pointer' }} onClick={() => applyTpl(t)}>
                <div className="rw-dash-title">🧩 {t.name}</div>
                <div className="rw-dash-muted" style={{ fontSize: 12 }}>{t.hint || ''}</div>
                {(t.skills || []).map((s) => <span key={s} className="rw-provider-model">技能:{s}</span>)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* step1 身份 */}
      {step === 1 && (
        <div>
          <div className="rw-cap-gtitle">身份（key 唯一且不可与既有壳冲突；import 同 key=更新）</div>
          {input('key（小写字母数字连字符，2-32 位，定后难改）', pack.key, (v) => setP((p) => { p.key = v.trim().toLowerCase(); return p; }), { ph: 'myagent' })}
          {input('name（展示名）', pack.name, (v) => setP((p) => { p.name = v; return p; }), { ph: '我的 Agent' })}
          {input('一句话定位 description', pack.description, (v) => setP((p) => { p.description = v; return p; }), { textarea: true, rows: 1 })}
        </div>
      )}

      {/* step2 人格与领域 */}
      {step === 2 && (
        <div>
          <div className="rw-cap-gtitle">人格与领域说明</div>
          <div className="rw-provider-models" style={{ marginBottom: 6 }}>{PERSONA_EXAMPLES.map((x) => <span key={x.t} className="rw-provider-model" title={x.s} style={{ cursor: 'pointer' }} onClick={() => setP((p) => { p.identity.persona = '[' + x.t + '] ' + x.s; return p; })}>{x.t}</span>)}</div>
          {input('persona（空=中性不扩展语境）', pack.identity.persona, (v) => setP((p) => { p.identity.persona = v; return p; }), { textarea: true, rows: 3, ph: '你是…专业简洁…' })}
          <div className="rw-provider-models" style={{ marginBottom: 6 }}>{DOMAIN_EXAMPLES.map((x) => <span key={x.t} className="rw-provider-model" title={x.s} style={{ cursor: 'pointer' }} onClick={() => setP((p) => { p.domain.agendsText = x.s; return p; })}>{x.t}</span>)}</div>
          {input('领域说明 agendsText（术语/边界/数据源）', pack.domain.agendsText, (v) => setP((p) => { p.domain.agendsText = v; return p; }), { textarea: true, rows: 2 })}
        </div>
      )}

      {/* step3 工具面 */}
      {step === 3 && (
        <div>
          <div className="rw-cap-gtitle">工具面（暴露档 ∩ 壳档；forceOn 越级放开 / forceOff 移除）</div>
          <div className="rw-console-toolbar">
            <span>壳档 presetBase：</span>
            <select className="rw-select" value={pack.tools.presetBase} onChange={(e) => setP((p) => { p.tools.presetBase = e.target.value; return p; })}>
              {Object.entries(PRESET_LB).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button className="rw-btn" onClick={() => quickPreset('dev')}>开发常用</button>
            <button className="rw-btn" onClick={() => quickPreset('research')}>调研常用</button>
            <button className="rw-btn" onClick={() => quickPreset('safe')}>安全精简</button>
          </div>
          <div className="rw-dash-muted" style={{ marginBottom: 8 }}>每工具三态：跟随全局（勾选集决定）/ 强制开 / 强制关。改后即时作用到该壳会话 schema。</div>
          {(['core', 'pro', 'expert'].map((tier) => (
            <div key={tier} style={{ marginBottom: 8 }}>
              <b style={{ fontSize: 12 }}>— {TIER_CN[tier]} 级 —</b>
              <div className="rw-provider-models">
                {tools.filter((t) => t.tier === tier).map((t) => (
                  <span key={t.name} className={'rw-provider-model' + (toolMode(t.name) === 'on' ? ' on' : toolMode(t.name) === 'off' ? ' off' : '')} style={{ cursor: 'pointer' }} title={(t.when ? '何时用：' + t.when + '\n' : '') + (t.not ? '勿用：' + t.not : '')}
                    onClick={() => setToolMode(t.name, toolMode(t.name) === 'follow' ? 'on' : toolMode(t.name) === 'on' ? 'off' : 'follow')}>
                    {t.cn || t.name}:{toolMode(t.name) === 'on' ? '强制开' : toolMode(t.name) === 'off' ? '强制关' : '跟随全局'}
                  </span>
                ))}
              </div>
            </div>
          )))}
          <div className="rw-dash-muted" style={{ fontSize: 11 }}>点击循环切换 跟随全局 → 强制开 → 强制关。</div>
        </div>
      )}

      {/* step4 模型策略 */}
      {step === 4 && (
        <div>
          <div className="rw-cap-gtitle">模型策略（壳默认模型=三级路由第三级；显式选模型始终优先）</div>
          <div className="rw-console-toolbar">
            <select className="rw-select" value={pack.modelPolicy.defaultProvider} onChange={(e) => setP((p) => { p.modelPolicy.defaultProvider = e.target.value; p.modelPolicy.defaultModel = ''; return p; })}>
              <option value="">（自动路由/不设壳默认）</option>
              {providers.map((p) => <option key={p.provider_key} value={p.provider_key}>{p.name}</option>)}
            </select>
            <select className="rw-select" value={pack.modelPolicy.defaultModel} onChange={(e) => setP((p) => { p.modelPolicy.defaultModel = e.target.value; return p; })}>
              <option value="">模型…</option>
              {mpModels.filter((m) => m.enabled).map((m) => <option key={m.model_id} value={m.model_id}>{m.model_id}</option>)}
            </select>
          </div>
          {input('预算上限 budgetYuan（元/会话累计段；0=不启用）', String(pack.modelPolicy.budgetYuan || ''), (v) => setP((p) => { p.modelPolicy.budgetYuan = Number(v) || 0; return p; }))}
          <div className="rw-dash-muted" style={{ fontSize: 11 }}>allowModels 白名单 / qualityCostBias：字段随 pack 存储（模型广场与档案消费层见 §5.1/§7.2 括注）；向导不开放编辑（即将支持）。</div>
        </div>
      )}

      {/* step5 技能 */}
      {step === 5 && (
        <div>
          <div className="rw-cap-gtitle">技能（勾选=并入壳 skills.allow；运行=会话 skill_load 生效/壳内点名）</div>
          <div className="rw-provider-models">
            {skills.length === 0 && <span className="rw-dash-muted">（无技能；由壳日报驱动沉淀，不强求新建）</span>}
            {skills.map((s) => (
              <span key={s.name} className={'rw-provider-model' + ((pack.skills.allow || []).includes(s.name) ? ' on' : '')} style={{ cursor: 'pointer' }}
                onClick={() => setP((p) => { const a = new Set(p.skills.allow || []); a.has(s.name) ? a.delete(s.name) : a.add(s.name); p.skills.allow = [...a].sort(); return p; })}>
                {s.description ? s.name + '：' + String(s.description).slice(0, 30) : s.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* step6 知识与扩展 */}
      {step === 6 && (
        <div>
          <div className="rw-cap-gtitle">知识与扩展（壳私有知识可后补；扩展=装载的 MCP/插件/应用）</div>
          <div className="rw-cap-item col">
            <span>知识范围（默认壳私有+全局共享）</span>
            <div className="rw-console-toolbar">
              {['global', 'shell'].map((sc) => (
                <label key={sc} className="rw-cap-item" style={{ padding: '2px 10px' }}>
                  <input type="checkbox" checked={(pack.knowledge.scopes || []).includes(sc)}
                    onChange={(e) => setP((p) => { const arr = new Set(p.knowledge.scopes || []); if (e.target.checked) arr.add(sc); else arr.delete(sc); p.knowledge.scopes = [...arr]; return p; })} />
                  {sc === 'global' ? '全局共享' : '壳私有'}
                </label>
              ))}
            </div>
          </div>
          <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>装配可用扩展（扩展中心资产：勾选=装载到本壳）</div>
          {exts.length === 0 && <div className="rw-dash-muted">（扩展注册表为空——A3 扩展中心页上架插件/MCP/应用后此处出现）</div>}
          {(['plugin', 'mcp', 'app']).map((type) => {
            const list = exts.filter((x) => x.type === type);
            if (!list.length) return null;
            return (
              <div key={type} style={{ marginBottom: 6 }}>
                <b style={{ fontSize: 12 }}>{type === 'plugin' ? '插件' : type === 'mcp' ? 'MCP 外部服务' : '应用'}</b>
                <div className="rw-provider-models">
                  {list.map((x) => (
                    <span key={x.key} className={'rw-provider-model' + (extChecked(type, x.key) ? ' on' : '')} style={{ cursor: 'pointer' }}
                      title={'状态:' + (x.statusCn || x.status) + ' · ' + (x.capability ? JSON.stringify(x.capability).slice(0, 120) : '')}
                      onClick={() => toggleExt(type, x.key)}>
                      {x.name || x.key}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* step7 护栏与对外 */}
      {step === 7 && (
        <div>
          <div className="rw-cap-gtitle">护栏与对外（accessRules 随 pack 存储；approvalMode/sensitiveDefaults/渠道/品牌=即将支持 伪配置防护）</div>
          {input('accessRules JSON（可空：[] 不启用随包规则；运行时全局 access_rules 已接线）', Array.isArray(pack.guardrails.accessRules) ? JSON.stringify(pack.guardrails.accessRules) : '', (v) => { try { const arr = JSON.parse(v); if (Array.isArray(arr)) setP((p) => { p.guardrails.accessRules = arr; return p; }); } catch { /* 非法 JSON 不写入 */ } }, { textarea: true, rows: 3, ph: '[{"pattern":"^run_command$","action":"deny","why":"禁跑"}]' })}
          <div className="rw-dash-muted" style={{ fontSize: 11 }}>对外形态（网页嵌入/会话 API/上下文注入）=后置专项（§5.5），向导不承接。</div>
        </div>
      )}

      {/* step8 验收 */}
      {step === 8 && (
        <div>
          <div className="rw-cap-gtitle">验收：pack 预览 → 建壳 → 扩展装载 → 金标 canary（装配冒烟接金标，变更即跑）</div>
          <pre style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', background: 'var(--rw-bg)', borderRadius: 8, padding: 8, maxHeight: 260, overflowY: 'auto' }}>{JSON.stringify(pack, null, 2)}</pre>
          <div className="rw-console-toolbar" style={{ marginTop: 8 }}>
            <button className="rw-btn pri" onClick={doCreate} disabled={busy || !canNext()}>{busy ? '建壳中…' : '🚀 建壳并冒烟'}</button>
            {pack && !(pack.tools.forceOn && pack.tools.forceOn.length) && !(pack.tools.forceOff && pack.tools.forceOff.length) && <span className="rw-dash-muted">（工具三态全跟随全局）</span>}
          </div>
          {result && (
            <div className="rw-provider" style={{ marginTop: 10 }}>
              <div className="rw-dash-title">装配完成：{result.shellKey}</div>
              <div className="rw-kb-msg" style={{ marginTop: 4 }}>✅ pack 已导入（DB 镜像更新）；会话选此壳即按 persona/工具面/模型策略执行。</div>
              <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>金标 canary 结果（eval.goldenSetRef 金标集）</div>
              {!result.canary || result.canary.skipped
                ? <div className="rw-dash-muted">{(!result.canary || !result.canary.ref) ? '未配置金标集（eval.goldenSetRef 为空）→ 跳过；门禁以 880 E2E+selfcheck 为准（§10 目标态前）' : '金标文件缺失或为空 → 跳过（' + (result.canary.reason || '') + '）'}</div>
                : (
                  <div>
                    <div className={'rw-provider-model' + (result.canary.passed === result.canary.total ? ' on' : ' off')}>通过 {result.canary.passed}/{result.canary.total}</div>
                    <ol style={{ fontSize: 12, paddingLeft: 18 }}>
                      {(result.canary.results || []).map((r, i) => <li key={i} className={r.pass ? '' : 'rw-trace-step fail'}>{(r.q || '') + ' → ' + (r.pass ? '✅ ' : '❌ 期望[' + r.want + '] 实得[' + r.got + ']')}</li>)}
                    </ol>
                  </div>
                )}
            </div>
          )}
        </div>
      )}

      <div className="rw-console-toolbar" style={{ marginTop: 12 }}>
        <button className="rw-btn" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>← 上一步</button>
        {step < 8 && <button className="rw-btn pri" onClick={() => setStep((s) => s + 1)} disabled={!canNext()}>下一步 →</button>}
        {step === 8 && (initial || result) && <button className="rw-btn pri" onClick={() => onClose && onClose()}>{result ? '完成，返回列表' : '完成'}</button>}
        {step !== 8 && <button className="rw-btn" onClick={() => (onClose ? onClose() : setStep(8))}>{initial ? '取消' : '跳到验收预览'}</button>}
      </div>
    </div>
  );
}
