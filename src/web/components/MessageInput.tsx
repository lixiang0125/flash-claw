interface MessageInputProps {
  onSend: (message: string) => void;
  disabled: boolean;
}

/**
 * 消息输入组件
 */
export function MessageInput({ onSend, disabled }: MessageInputProps) {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem('message') as HTMLInputElement;
    const value = input.value.trim();
    
    if (value) {
      onSend(value);
      input.value = '';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const input = e.currentTarget as HTMLInputElement;
      const value = input.value.trim();
      if (value) {
        onSend(value);
        input.value = '';
      }
    }
  };

  return (
    <form className="input-area" onSubmit={handleSubmit}>
      <input
        type="text"
        name="message"
        placeholder="输入消息..."
        disabled={disabled}
        onKeyDown={handleKeyDown}
      />
      <button type="submit" disabled={disabled}>
        发送
      </button>
    </form>
  );
}
