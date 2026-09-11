// 一键演示用的 faux agent 工厂（P16）：--mock 通道注入，预设回复不依赖真实模型集群。
// 序列设计=演示亮点：节点申报 task_check（shadow 级阻塞 → 现场人工放行）→ 放行后汇报。
// 文件在 console-api 包内，bare specifier 解析到本包 node_modules（同 test/fixtures 约定）。
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';

export function agentFactory(opts) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    // item 必须是任务包清单里的合法项 id（如 T-1）——传错会 isError 打回，shadow 闸门不触发（演示实测踩坑）
    fauxAssistantMessage(fauxToolCall('task_check', { item: 'T-1', result: 'T-1 本地自测通过，逐项对照验收标准确认，申报节点验收' })),
    fauxAssistantMessage(fauxText('节点验收已申报并通过人工放行。本任务项完成：代码已按需求实现并自测，等待班组下游任务继续。')),
  ]);
  return new Agent({
    initialState: { systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools },
    streamFn: models.streamSimple.bind(models),
  });
}
