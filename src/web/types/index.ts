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
  skill?: string;
}

/**
 * Chat API 响应体
 */
export interface ChatResponse {
  response: string;
  sessionId: string;
  skills?: Skill[];
}

/**
 * Skill 类型
 */
export interface Skill {
  name: string;
  description: string;
  instructions?: string;
  examples?: string[];
}
