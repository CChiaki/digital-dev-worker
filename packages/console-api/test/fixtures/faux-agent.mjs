// worker 组装单测的 faux agent 工厂模块（经 workerJob.config.agentModulePath 动态 import 注入；
// 文件须在包内以使 bare specifier 解析到本包 node_modules）。
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';

export function agentFactory(opts) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    // shadow 级：task_check 申报后阻塞等人工放行，verdict 回传后汇报
    fauxAssistantMessage(fauxToolCall('task_check', { item: 'T-1', result: '自测通过' })),
    fauxAssistantMessage(fauxText('worker 伪执行完成')),
  ]);
  return new Agent({
    initialState: { systemPrompt: opts.systemPrompt, model: faux.getModel(), tools: opts.tools },
    streamFn: models.streamSimple.bind(models),
  });
}
