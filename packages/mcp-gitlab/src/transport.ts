/** GitLab REST 传输层：生产=fetch 实现（baseUrl/token 注入），测试=fake。
 *  契约与实现分离（spec 7.1）：工具契约不变，传输可替换（API / Playwright 垫片）。 */
export interface GitLabResponse {
  status: number;
  json: unknown;
}

export interface GitLabTransport {
  request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<GitLabResponse>;
}

export interface FetchGitLabOptions {
  /** GitLab 根地址，如 http://gitlab.inner.bank */
  baseUrl: string;
  /** 私有访问令牌 */
  token: string;
  /** API 前缀，默认 /api/v4 */
  apiPrefix?: string;
}

export class FetchGitLabTransport implements GitLabTransport {
  private readonly baseUrl: string;
  private readonly apiPrefix: string;

  constructor(private readonly options: FetchGitLabOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiPrefix = options.apiPrefix ?? '/api/v4';
  }

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<GitLabResponse> {
    const url = `${this.baseUrl}${this.apiPrefix}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.options.token,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }
}
