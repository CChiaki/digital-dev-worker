export type BuildStatus = 'created' | 'running' | 'success' | 'failed' | 'canceled';

export interface BuildInfo {
  id: string;
  status: BuildStatus;
}

/**
 * CI 平台传输接口：行内 DevOps 平台适配器（生产 = HTTP 实现），
 * 测试/本地联调注入 fake。同 mcp-gitlab 的 transport 注入模式。
 */
export interface CiTransport {
  triggerBuild(req: { project: string; ref: string }): Promise<{ id: string }>;
  getBuild(id: string): Promise<BuildInfo>;
  getLog(id: string, tailLines?: number): Promise<string>;
}
