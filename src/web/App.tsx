import { useState, useEffect } from 'react';
import { useChat } from './hooks/useChat';
import { Header, MessageList, MessageInput, TypingIndicator } from './components';
import './App.css';

interface Skill {
  name: string;
  description: string;
}

/**
 * 主应用组件
 */
export default function App() {
  const { messages, isLoading, sessionId, send, clear } = useChat();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [activeSkill, setActiveSkill] = useState<string>('');

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
