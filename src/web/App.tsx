import { useState, useEffect } from 'react';
import { useChat } from './hooks/useChat';
import { Header, MessageList, MessageInput, StatusBanner, TypingIndicator } from './components';
import { getBackendStatus } from './api/status';
import type { BackendStatus, Skill } from './types';
import './App.css';

/**
 * 主应用组件
 */
export default function App() {
  const { messages, isLoading, sessionId, send, clear } = useChat();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [activeSkill, setActiveSkill] = useState<string>('');
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [isStatusLoading, setIsStatusLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const loadStatus = async () => {
      try {
        const status = await getBackendStatus();
        if (mounted) {
          setBackendStatus(status);
        }
      } catch {
        if (mounted) {
          setBackendStatus(null);
        }
      } finally {
        if (mounted) {
          setIsStatusLoading(false);
        }
      }
    };

    loadStatus();
    const timer = window.setInterval(loadStatus, 30_000);

    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    fetch('/api/skills')
      .then(res => res.json())
      .then(data => setSkills(data))
      .catch(console.error);
  }, []);

  const handleSend = (content: string) => {
    send(content);
    setActiveSkill('');
  };

  return (
    <div className="container">
      <Header sessionId={sessionId} onClear={clear} />
      <StatusBanner status={backendStatus} isLoading={isStatusLoading} />
      
      {skills.length > 0 && (
        <div className="skill-bar">
          <select 
            value={activeSkill} 
            onChange={(e) => setActiveSkill(e.target.value)}
            className="skill-select"
          >
            <option value="">选择 Skill (可选)</option>
            {skills.map(skill => (
              <option key={skill.name} value={skill.name}>
                {skill.description}
              </option>
            ))}
          </select>
        </div>
      )}
      
      <MessageList messages={messages} />
      {isLoading && <TypingIndicator />}
      <MessageInput 
        onSend={handleSend} 
        disabled={isLoading}
        skill={activeSkill}
      />
    </div>
  );
}
