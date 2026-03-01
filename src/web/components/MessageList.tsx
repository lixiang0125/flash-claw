import type { Message } from '../types';

interface MessageListProps {
  messages: Message[];
}

/**
 * 工具调用结果组件
 */
function ToolCallResult({ toolCalls }: { toolCalls: Message['toolCalls'] }) {
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div className="tool-calls">
      {toolCalls.map((call, index) => (
        <div key={index} className={`tool-call ${call.error ? 'error' : 'success'}`}>
          <div className="tool-call-header">
            <span className="tool-name">{call.tool}</span>
            {call.error && <span className="tool-error">Error</span>}
          </div>
          <pre className="tool-output">{call.error || call.output}</pre>
        </div>
      ))}
    </div>
  );
}

/**
 * 消息列表组件
 */
export function MessageList({ messages }: MessageListProps) {
  return (
    <div className="messages">
      {messages.map((msg) => (
        <div key={msg.id} className={`message ${msg.role}`}>
          <div className="message-content">{msg.content}</div>
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <ToolCallResult toolCalls={msg.toolCalls} />
          )}
        </div>
      ))}
    </div>
  );
}
