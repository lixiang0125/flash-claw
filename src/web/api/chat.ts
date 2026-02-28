import type { ChatRequest, ChatResponse } from '../types';

/**
 * API 基础地址
 * 开发环境使用相对路径，会通过 Vite 代理到后端
 */
const API_BASE = '';

/**
 * 发送聊天消息
 */
export async function sendMessage(request: ChatRequest): Promise<ChatResponse> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  
  if (!res.ok) {
    throw new Error(`请求失败: ${res.status}`);
  }
  
  return res.json();
}

/**
 * 清除会话
 */
export async function clearSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/chat/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  
  if (!res.ok) {
    throw new Error(`请求失败: ${res.status}`);
  }
}
