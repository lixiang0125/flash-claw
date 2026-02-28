/**
 * 消息类型定义
 */
export interface Message {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: number;
}

/**
 * Chat API 请求体
 */
export interface ChatRequest {
  message: string;
  sessionId?: string;
}

/**
 * Chat API 响应体
 */
export interface ChatResponse {
  response: string;
  sessionId: string;
}
