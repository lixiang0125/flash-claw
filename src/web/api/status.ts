import type { BackendStatus } from '../types';

/**
 * 获取后端连通性和当前生效的模型配置，用于 Web 页状态提示。
 */
export async function getBackendStatus(): Promise<BackendStatus> {
  const response = await fetch('/api/status');

  if (!response.ok) {
    throw new Error(`状态请求失败: ${response.status}`);
  }

  return response.json();
}
