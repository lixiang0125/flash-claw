import { useState, useCallback } from 'react';
import type { Message } from '../types';
import { sendMessage, clearSession } from '../api/chat';

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 聊天相关的数据和操作
 */
export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId] = useState(() => {
    const stored = localStorage.getItem('sessionId');
    if (stored) return stored;
    const newId = `session_${Date.now()}`;
    localStorage.setItem('sessionId', newId);
    return newId;
  });

  /**
   * 发送消息
   */
  const send = useCallback(async (content: string) => {
    const userMessage: Message = {
      id: generateId(),
      content,
      role: 'user',
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    try {
      const response = await sendMessage({ message: content, sessionId });
      
      const assistantMessage: Message = {
        id: generateId(),
        content: response.response,
        role: 'assistant',
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: Message = {
        id: generateId(),
        content: error instanceof Error ? error.message : '请求失败',
        role: 'assistant',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  /**
   * 清除会话
   */
  const clear = useCallback(async () => {
    try {
      await clearSession(sessionId);
      setMessages([]);
      const newId = `session_${Date.now()}`;
      localStorage.setItem('sessionId', newId);
    } catch (error) {
      console.error('清除会话失败:', error);
    }
  }, [sessionId]);

  return {
    messages,
    isLoading,
    sessionId,
    send,
    clear,
  };
}
