/**
 * 工作区契约（spec 4.3）：数字员工的文件操作全部走相对路径，实现方负责逃逸防护。
 * LocalWorkspace（本目录 local-workspace.js）为唯一实现；测试可注入内存实现。
 */

/** 工作区后端：相对路径读写 + 越界拒绝（resolve 是一切路径操作的收口点） */
export interface Workspace {
  /** 工作区根绝对路径 */
  readonly root: string;
  /** 相对路径 → 绝对路径（越界/绝对输入抛错）；一切读写前必经 */
  resolve(rel: string): string;
  /** 写文件（自动建父目录；root 不存在时惰性创建） */
  writeFile(rel: string, content: string): Promise<void>;
  /** 读文件（不存在抛含路径的可读错误） */
  readFile(rel: string): Promise<string>;
  /** 精确替换（P0 结论：oldText 全文件唯一命中才改，多处/零处抛错且不动文件） */
  editFile(rel: string, oldText: string, newText: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  /** 递归列出相对路径（跳过 .git / node_modules）；limit 截断 */
  listTree(sub?: string, limit?: number): Promise<string[]>;
}

/** 执行层硬防线（spec 4.7）：argv 翻译中间层，位于白名单软防线之后、真实 exec 之前。
 *  Noop=直跑（试点）；Bwrap=系统级沙箱；Docker=容器 exec。同一 ControlledBash 三档可换。 */
export interface SandboxBackend {
  readonly name: string;
  /** 把原始 argv 翻译为带沙箱包装的 argv（不动语义，只加壳） */
  wrap(argv: string[]): string[];
}

/** ControlledBash.exec 结果：ok = 白名单/黑名单/超时全过且退出码 0 */
export interface BashExecResult {
  ok: boolean;
  /** 仅真实执行过才有（白名单拒绝等前置拦截为 undefined） */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** 失败原因（中文可读，含拦截策略名/超时/退出码） */
  error?: string;
}
