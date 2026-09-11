export type DeployEnv = 'test' | 'staging';
export type DeployStatus = 'pending' | 'deploying' | 'done' | 'failed';

export interface DeployInfo {
  id: string;
  status: DeployStatus;
}

/** 行内部署平台适配接口（生产 = HTTP；测试注入 fake） */
export interface DeployTransport {
  deploy(req: { project: string; env: DeployEnv; version: string }): Promise<{ id: string; status: string }>;
  getDeploy(id: string): Promise<DeployInfo>;
}
