// src/FileAttach.jsx - 输入区附件上传（点击选择 或 拖文件到按钮/整窗——整窗遮罩由 Chat 承担）
// 上传经 /api/upload 落到服务端 {RW_WORKSPACE}/uploads/<ts>-<安全名>，成功后把
// 绝对路径回填到输入框，方便 Agent 用 extract_xlsx / extract_pdf / extract_docx 等解析。
// 另导出 uploadToServer() 供 Chat 整窗拖拽复用同一套上传逻辑。
import React, { useRef, useState } from 'react';
import { api } from './api.js';

const MAX_BYTES = 8 * 1024 * 1024; // 与 /api/upload 服务端上限一致

// 上传单个文件到 /api/upload；成功返回 { abs, rel, name }，失败/超限返回 null（并 toast 原因）
export async function uploadToServer(file, onToast) {
  if (!file) return null;
  if (file.size > MAX_BYTES) { onToast && onToast('文件超过 8MB 上限，无法上传'); return null; }
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
    const out = await api.upload(file.name, base64);
    if (!out || !out.ok) { onToast && onToast((out && out.message) || '上传失败，请重试'); return null; }
    // 服务端返回 { ok:true, path: '/srv/rw-workspace/uploads/<ts>-<safe名>' }
    const abs = (out.path || '').replace(/\\/g, '/');
    const rel = abs.includes('/uploads/') ? 'uploads/' + abs.split('/uploads/')[1] : abs;
    return { abs, rel, name: file.name };
  } catch (e) {
    onToast && onToast('上传失败：' + String((e && e.message) || e));
    return null;
  }
}

export default function FileAttach({ disabled, onAttached, onToast }) {
  const fileRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleFiles(fileList) {
    const f = fileList && fileList[0];
    if (!f) return;
    setBusy(true);
    try {
      const r = await uploadToServer(f, onToast);
      if (r) onAttached && onAttached(r.abs, r.rel, r.name);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={'rw-attach-btn' + (drag ? ' drag' : '')}
      disabled={disabled || busy}
      title={disabled ? '请先创建/选择会话后再上传附件' : '点击选择文件，或把文件（Excel/PDF/Word/PPT/图片/文本等，≤8MB）拖到对话区任意处松开上传'}
      onClick={() => { if (!disabled && !busy && fileRef.current) fileRef.current.click(); }}
      onDragOver={(e) => { e.preventDefault(); if (!disabled && !busy) setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDrag(false);
        if (!disabled && !busy) handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
      />
      {busy ? '⏳ 上传中…' : drag ? '📥 松开上传' : '📎 附件'}
    </button>
  );
}
