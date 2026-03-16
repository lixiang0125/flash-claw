import type { Skill } from "../skills";

export interface ChatRequest {
  message: string;
  sessionId?: string;
  userId?: string;
  skill?: string;
}

export interface ChatResponse {
  response: string;
  sessionId: string;
  skills?: Skill[];
  autoMatched?: string;
}

/**
 * 流式聊天回调接口。
 * ChatEngine.chatStream() 通过此回调逐步推送文本片段。
 */
export interface StreamCallbacks {
  /** 每当收到新的文本 delta 时触发，fullText 为累积的完整文本 */
  onDelta: (delta: string, fullText: string) => void | Promise<void>;
  /** 流结束时触发，fullText 为最终完整文本 */
  onDone: (fullText: string) => void | Promise<void>;
  /** 发生错误时触发 */
  onError?: (error: Error) => void | Promise<void>;
}
