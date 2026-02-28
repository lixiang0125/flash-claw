import type { Message } from '../types';

interface MessageListProps {
  messages: Message[];
}

/**
 * 消息列表组件
 */
export function MessageList({ messages }: MessageListProps) {
  return (
    <div className="messages">
      {messages.map((msg) => (
        <div key={msg.id} className={`message ${msg.role}`}>
          {msg.content}
        </div>
      ))}
    </div>
  );
}
