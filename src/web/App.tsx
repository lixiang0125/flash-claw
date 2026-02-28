import { useChat } from './hooks/useChat';
import { Header, MessageList, MessageInput, TypingIndicator } from './components';
import './App.css';

/**
 * 主应用组件
 */
export default function App() {
  const { messages, isLoading, sessionId, send, clear } = useChat();

  return (
    <div className="container">
      <Header sessionId={sessionId} onClear={clear} />
      <MessageList messages={messages} />
      {isLoading && <TypingIndicator />}
      <MessageInput onSend={send} disabled={isLoading} />
    </div>
  );
}
