/** 验证环境探活适配接口（生产 = HTTP 探测；测试注入 fake） */
export interface TestenvTransport {
  check(url: string): Promise<{ status: number; body: string }>;
}
