// worker plan 任务 e2e 的 faux agent 工厂模块（经 workerJob.config.agentModulePath 动态 import 注入；
// 文件须在包内以使 bare specifier 解析到本包 node_modules）。
// 每个 prompt（= 一个计划项）播放固定脚本：task_check 申报 T-1/T-2（跨两项各有一次合法申报）→ 汇报。
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';

export function agentFactory(opts) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('task_check', { item: 'T-1', result: '开发完成', passed: true })),
    fauxAssistantMessage(fauxToolCall('task_check', { item: 'T-2', result: '测试通过', passed: true })),
    fauxAssistantMessage(fauxText('计划项伪执行完成')),
  ]);
  return new Agent({
    initialState: { systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools },
    streamFn: models.streamSimple.bind(models),
  });
}
