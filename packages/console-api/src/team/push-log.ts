// packages/console-api/src/team/push-log.ts
/** 推送留痕（2026-09-10 用户需求：推送的消息要有记录的地方）：
 *  消息中心每条消息 × 每个启用渠道的推送结果——此前只进进程日志，燕讯静默丢投无从排查 */

/** 单次推送记录：一条消息 × 一个渠道 */
export interface PushLogRecord {
  id: string;
  /** 对应消息中心记录 id */
  messageId: string;
  taskId: string;
  /** 消息类型（对齐 MessageType）：review_required/task_failed/task_done/skill_pending */
  messageTitle: string;
  channelId: string;
  channelType: string;
  channelName: string;
  /** sent = 渠道返回成功；failed = 推送异常（error 带原因） */
  status: 'sent' | 'failed';
  /** 失败原因（status=failed 时） */
  error?: string;
  /** 燕讯全局流水号（type=yanxun 推送成功留痕；S ≠ 已投递，凭此号找平台方定位静默丢投） */
  yanxunSeqNo?: string;
  createdAt: number;
}

/** list 过滤项：taskId 按任务 / messageId 按消息（消息中心下钻）/ limit 条数上限 */
export interface PushLogListOpts {
  taskId?: string;
  messageId?: string;
  limit?: number;
}

export interface PushLogStore {
  /** list 默认最新在前（created_at DESC, id DESC） */
  list(opts?: PushLogListOpts): Promise<PushLogRecord[]>;
  add(rec: Omit<PushLogRecord, 'id' | 'createdAt'> & { id?: string }): Promise<PushLogRecord>;
}
