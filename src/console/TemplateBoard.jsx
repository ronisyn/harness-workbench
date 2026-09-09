// src/console/TemplateBoard.jsx - ⑥ 任务模板库（§7.5：模板=档案+技能+验收+说明；Agent 页子区，定案 A）
// 功能：模板浏览 + 详情 + 应用至壳 + 开任务指令 + A2 导出/导入/克隆（模板=文件权威随 git，写盘自动 git 提交推送）。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function TemplateBoard() {
  const [templates, setTemplates] = useState([]);
  const [cur, setCur] = useState(null);       // 当前查看模板（完整）
  const [shells, setShells] = useState([]);
  const [targetShell, setTargetShell] = useState('');
  const [goal, setGoal] = useState('');
  const [prompt, setPrompt] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [tplEditor, setTplEditor] = useState(false); // 导入表单（新建/覆盖同 key）
  const [tplJson, setTplJson] = useState('');

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([api.templates(), api.shells().catch(() => ({ shells: [] }))]);
      setTemplates(t.templates || []);
      const usable = (s.shells || []).filter((x) => x.status === 'enabled' && x.skey !== 'default');
      setShells(usable);
      if (usable.length) setTargetShell((v) => v || usable[0].skey);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openTpl = async (key) => {
    setErr(''); setMsg(''); setPrompt(''); setGoal('');
    try { const d = await api.templateGet(key); setCur(d.template); }
    catch (e) { setErr(e.message); }
  };

  const doApply = async () => {
    if (!cur || !targetShell) { setErr('请先选模板与目标壳'); return; }
    try {
      const r = await api.templateApply(cur.key, targetShell);
      setMsg('已装配到壳 ' + targetShell + '：档案「' + r.profile + '」生效（该壳会话点名即可路由）');
    } catch (e) { setErr(e.message); }
  };

  const doPrompt = async () => {
    if (!cur) return;
    try { const r = await api.templatePrompt(cur.key, goal); setPrompt(r.prompt); }
    catch (e) { setErr(e.message); }
  };

  // A2 模板库管理：导出（下载 tpl.json）
  const doExport = async (key) => {
    try {
      const text = await api.templateExport(key);
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = key + '.tpl.json';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      setMsg('已导出 ' + key + '.tpl.json');
    } catch (e) { setErr('导出失败：' + e.message); }
  };
  // 克隆（改 key）
  const doClone = async (key) => {
    const nk = prompt('新模板 key（小写字母数字-）', key + '-copy');
    if (!nk) return;
    try { const r = await api.templateClone(key, nk, undefined); setMsg('已克隆 ' + key + ' → ' + r.key + (r.gitSynced ? '（git 已推送）' : '（git 无变更）')); load(); }
    catch (e) { setErr('克隆失败：' + e.message); }
  };
  // 导入（粘贴/改写 JSON；同 key=覆盖更新；写盘后 git 自动提交推送）
  const doImport = async () => {
    try {
      const tpl = JSON.parse(tplJson);
      const r = await api.templateImport(tpl);
      setMsg('已导入模板 ' + r.key + '（' + (r.mode === 'updated' ? '覆盖更新' : '新建') + '）' + (r.gitSynced ? '；git 已同步 origin' : ''));
      setTplEditor(false); setTplJson(''); setCur(null); load();
    } catch (e) { setErr('导入失败：' + e.message); }
  };

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">任务模板库（⑥ · 模板=应用的半成品；Agent 页子区 §7.5 定案 A）</div>
      <div className="rw-dash-muted" style={{ marginBottom: 10 }}>
        D9 命名：壳=容器 / 应用=业务单元 / 档案+技能+验收=应用组成件。v1 承载=模板包（taskProfile+技能+验收+说明）；可执行应用形态随后续。
      </div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-console-toolbar" style={{ marginBottom: 8 }}>
        <button className="rw-btn" onClick={() => { setTplEditor((v) => !v); setErr(''); setMsg(''); }}>{tplEditor ? '收起导入' : '＋ 导入/新建模板'}</button>
        {cur && <button className="rw-btn" onClick={() => doClone(cur.key)}>克隆该模板</button>}
        <span className="rw-dash-muted">（导入/克隆写 templates/&lt;key&gt;/tpl.json 并自动 git 提交推送，保持仓库同步）</span>
      </div>
      {tplEditor && (
        <div className="rw-provider" style={{ marginBottom: 10 }}>
          <div className="rw-cap-gtitle">导入模板（tpl.json 结构；同 key=覆盖更新）</div>
          <textarea className="rw-input" rows="10" style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} value={tplJson} onChange={(e) => setTplJson(e.target.value)} placeholder='{"templateVersion":1,"key":"my-tpl","name":"…","description":"…","targetShell":"…","taskProfile":{…},"skills":[…],"acceptanceTemplate":{…},"guide":"…"}' />
          <button className="rw-btn pri" onClick={doImport} disabled={!tplJson.trim()}>导入</button>
        </div>
      )}
      <div className="rw-dash-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
        {templates.length === 0 && <div className="rw-console-ph"><div>暂无模板（仓库 templates/ 目录为空）</div></div>}
        {templates.map((t) => (
          <div key={t.key} className="rw-dash-card" style={{ cursor: 'pointer' }} onClick={() => openTpl(t.key)}>
            <div className="rw-dash-title">🧩 {t.name || t.key}</div>
            <div className="rw-dash-muted" style={{ fontSize: 12 }}>{String(t.description || '').slice(0, 90)}</div>
            <div className="rw-provider-models" style={{ marginTop: 6 }}>
              {t.profileKey && <span className="rw-provider-model">档案: {t.profileKey}</span>}
              {(t.skills || []).map((s) => <span key={s} className="rw-provider-model">技能: {s}</span>)}
              <span className="rw-provider-model">验收点: {t.checks || 0}</span>
              {t.targetShell && <span className="rw-provider-model">建议壳: {t.targetShell}</span>}
            </div>
            <div className="rw-console-toolbar" style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
              <button className="rw-btn" onClick={() => doExport(t.key)}>导出</button>
              <button className="rw-btn" onClick={() => doClone(t.key)}>克隆</button>
            </div>
          </div>
        ))}
      </div>

      {cur && (
        <div className="rw-provider" style={{ marginTop: 14 }}>
          <div className="rw-dash-title">{cur.name}（{cur.key}）</div>
          <div className="rw-dash-muted">{cur.description}</div>
          <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>档案（taskProfile）</div>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', background: 'var(--rw-bg)', borderRadius: 8, padding: 8 }}>{JSON.stringify(cur.taskProfile, null, 2)}</pre>
          <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>技能 + 验收</div>
          <div className="rw-provider-models">{(cur.skills || []).map((s) => <span key={s} className="rw-provider-model">{s}</span>)}</div>
          <ol style={{ fontSize: 12.5, paddingLeft: 18 }}>
            {(cur.acceptanceTemplate?.checks || []).map((c, i) => <li key={i}>{c}</li>)}
          </ol>
          {cur.guide && <div className="rw-dash-result" style={{ marginTop: 8 }}>说明：{cur.guide}</div>}

          <div className="rw-cap-gtitle" style={{ marginTop: 12 }}>应用至壳（壳会话点名该档案即按模板路由/受技能约束）</div>
          <div className="rw-console-toolbar">
            <select className="rw-select" value={targetShell} onChange={(e) => setTargetShell(e.target.value)}>
              {shells.map((s) => <option key={s.skey} value={s.skey}>{s.name}（{s.skey}）</option>)}
            </select>
            <button className="rw-btn pri" onClick={doApply}>装配到该壳</button>
          </div>

          <div className="rw-cap-gtitle" style={{ marginTop: 12 }}>从模板开任务（生成开任务指令 → 复制到对话页发送）</div>
          <div className="rw-console-toolbar">
            <input className="rw-input" style={{ flex: 1 }} placeholder="本次具体目标（可空，如：修复登录按钮失效）" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <button className="rw-btn" onClick={doPrompt}>生成指令</button>
          </div>
          {prompt && (
            <div className="rw-provider" style={{ marginTop: 8 }}>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{prompt}</pre>
              <button className="rw-btn" onClick={() => { navigator.clipboard?.writeText(prompt); setMsg('已复制指令，去「💬 对话页」粘贴发送即从模板开任务'); }}>复制指令</button>
            </div>
          )}
          <div className="rw-console-toolbar" style={{ marginTop: 8 }}>
            <button className="rw-btn" onClick={() => setCur(null)}>← 收起</button>
          </div>
        </div>
      )}
      <div className="rw-console-note">模板包随仓库 git 版本管理（templates/&lt;key&gt;/tpl.json）：导入/克隆由平台自动 git 提交推送 origin（导出=纯下载）；git 文件版本管理即备份通道。可执行应用形态（独立运行/挂壳/共享）=后置。</div>
    </div>
  );
}
