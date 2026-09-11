import type { Agent, AgentMessage, Session } from '@earendil-works/pi-agent-core';

/** 产品层持久化接线：agent 事件 → session 落盘。
 *  落盘前 JSON 规范化：session 的 assertJsonSerializable 拒绝 undefined 值/访问器/
 *  非普通对象，而运行时消息可能携带这些（如 provider 附加字段）。
 *  返回 async 停止函数：先退订再 await 全部 pending 落盘——appendMessage 是异步写盘，
 *  若不等待，后续读文件断言会读到不完整的 transcript（实测踩过的竞态）。 */
export function wireSession(agent: Agent, session: Session): () => Promise<void> {
  const pending: Promise<unknown>[] = [];
  const unsub = agent.subscribe((e) => {
    if (e.type === 'message_end') {
      pending.push(session.appendMessage(JSON.parse(JSON.stringify(e.message)) as AgentMessage));
    }
  });
  return async () => {
    unsub();
    await Promise.all(pending);
  };
}
