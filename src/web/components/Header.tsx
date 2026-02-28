interface HeaderProps {
  sessionId: string;
  onClear: () => void;
}

/**
 * 页面头部组件
 */
export function Header({ sessionId, onClear }: HeaderProps) {
  const handleClear = () => {
    if (confirm('确定要清除当前会话吗？')) {
      onClear();
    }
  };

  return (
    <div className="header">
      <h1>Flash Claw Chat</h1>
      <div className="header-right">
        <span className="session-info">Session: {sessionId.slice(0, 12)}</span>
        <button className="clear-btn" onClick={handleClear}>
          Clear Session
        </button>
      </div>
    </div>
  );
}
