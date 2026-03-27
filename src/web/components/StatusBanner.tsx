import type { BackendStatus } from '../types';

interface StatusBannerProps {
  status: BackendStatus | null;
  isLoading: boolean;
}

/**
 * 顶部状态条：显示前端是否已连上后端，以及当前生效的模型配置。
 */
export function StatusBanner({ status, isLoading }: StatusBannerProps) {
  const connectionText = isLoading
    ? '正在检查后端状态...'
    : status?.backend.connected
      ? '后端已连接'
      : '后端未连接';
  const modelText = status?.llm.model || '未配置模型';
  const endpointText = status?.llm.baseURL || 'OpenAI 默认端点';
  const readinessText = status?.llm.apiKeyConfigured ? 'API Key 已配置' : 'API Key 未配置';

  return (
    <div className={`status-banner ${status?.backend.connected ? 'online' : 'offline'}`}>
      <div className="status-pill-group">
        <span className="status-pill">{connectionText}</span>
        <span className="status-pill">模型: {modelText}</span>
        <span className="status-pill">{readinessText}</span>
      </div>
      <div className="status-endpoint">端点: {endpointText}</div>
    </div>
  );
}
