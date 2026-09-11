export interface InterceptorVerdict {
  block: boolean;
  reason: string;
}

export interface ToolInterceptor {
  name: string;
  /** null = 放行 */
  check(input: { toolName: string; args: Record<string, unknown> }): InterceptorVerdict | null;
}
