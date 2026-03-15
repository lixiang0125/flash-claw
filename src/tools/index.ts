/**
 * @deprecated 此模块仅保留 setSubAgentSystem 供 bootstrap.ts 使用。
 * 旧工具系统已迁移至 src/tools/builtin/ 目录。
 */

interface SubAgentSystemAPI {
  spawn(config: {
    task: string;
    label?: string;
    runTimeoutSeconds?: number;
    mode?: string;
    cleanup?: string;
  }, parentSessionId: string): Promise<{ status: string; runId: string; childSessionKey: string }>;
}
let _subAgentSystem: SubAgentSystemAPI | null = null;
export function setSubAgentSystem(sys: SubAgentSystemAPI): void {
  _subAgentSystem = sys;
}
