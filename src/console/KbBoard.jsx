// src/console/KbBoard.jsx - 1.7 知识库（§6.3/④：管理视图+上传链，embedded 内嵌模式）
import React from 'react';
import Knowledge from '../Knowledge.jsx';

export default function KbBoard() {
  return <Knowledge embedded onClose={() => {}} />;
}
