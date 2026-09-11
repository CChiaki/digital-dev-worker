/** Jira REST 传输层：生产=fetch（Basic Auth baseUrl/token 注入），测试=fake。 */
export interface JiraResponse {
  status: number;
  json: unknown;
}

export interface JiraTransport {
  request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<JiraResponse>;
}

export interface FetchJiraOptions {
  /** Jira 根地址，如 http://jira.inner.bank */
  baseUrl: string;
  /** 认证信息（Basic: user:token 的 base64，或 Bearer token，按行内网关约定） */
  authHeader: string;
  /** API 前缀，默认 /rest/api/2 */
  apiPrefix?: string;
}

export class FetchJiraTransport implements JiraTransport {
  private readonly baseUrl: string;
  private readonly apiPrefix: string;

  constructor(private readonly options: FetchJiraOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiPrefix = options.apiPrefix ?? '/rest/api/2';
  }

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<JiraResponse> {
    const url = `${this.baseUrl}${this.apiPrefix}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.options.authHeader,
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
