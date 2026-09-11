import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../src/api.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

function jsonRes(json: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => json };
}

describe('api client', () => {
  it('listTasks → GET /api/tasks', async () => {
    fetchMock.mockResolvedValue(jsonRes([{ taskId: 'T1' }]));
    const r = await api.listTasks();
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({ method: 'GET' }));
    expect(r).toEqual([{ taskId: 'T1' }]);
  });

  it('createTask(yaml) → POST /api/tasks，body 为 yaml 原文', async () => {
    fetchMock.mockResolvedValue(jsonRes({ taskId: 'T1' }, 201));
    await api.createTask('taskId: T1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tasks');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('taskId: T1');
    expect(init.headers['content-type']).toContain('text/plain');
  });

  it('claimTask → POST /api/tasks/:id/claim，JSON body', async () => {
    fetchMock.mockResolvedValue(jsonRes({ status: 'claimed' }));
    await api.claimTask('T1', 'emp-01');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tasks/T1/claim');
    expect(init.body).toBe(JSON.stringify({ employeeId: 'emp-01' }));
    expect(init.headers['content-type']).toContain('application/json');
  });

  it('listEvents → GET /api/events 带查询参数', async () => {
    fetchMock.mockResolvedValue(jsonRes([]));
    await api.listEvents({ taskId: 'T1', type: 'tool_call', since: 1000 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/events?taskId=T1&type=tool_call&since=1000');
  });

  it('resumeTask → POST /api/tasks/:id/resume，返回任务详情记录（后端 resumePlan 契约）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ pkg: { taskId: 'T1' }, status: 'pending' }));
    const r = await api.resumeTask('T1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tasks/T1/resume');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({}));
    expect(r.status).toBe('pending');
  });

  it('HTTP 非 2xx 抛错（带服务端 error 信息）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: '任务不存在: NOPE' }, 404));
    await expect(api.getTask('NOPE')).rejects.toThrow('任务不存在: NOPE');
  });

  // 消息中心（Task 10）：listMessages / markMessageRead / markAllMessagesRead
  it('listMessages → GET /api/messages（unreadOnly 默认关），返回 { messages, unread }', async () => {
    fetchMock.mockResolvedValue(jsonRes({ messages: [{ id: 'm1' }], unread: 3 }));
    const r = await api.listMessages();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/messages');
    expect(r.unread).toBe(3);
  });

  it('listMessages 过滤/分页参数 → query 串拼接（2026-09-10 重设计）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ messages: [], total: 0, unread: 0 }));
    await api.listMessages({ unreadOnly: true });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/messages?unreadOnly=1');

    await api.listMessages({ type: 'task_failed', q: 'TASK-9', limit: 20, offset: 40 });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/messages?type=task_failed&q=TASK-9&limit=20&offset=40');
  });

  it('markMessageRead → POST /api/messages/:id/read；markAllMessagesRead → POST /api/messages/read-all', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'm1', read: true }));
    expect(await api.markMessageRead('m1')).toEqual({ id: 'm1', read: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/messages/m1/read');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({}));

    fetchMock.mockResolvedValue(jsonRes({ marked: 5 }));
    expect(await api.markAllMessagesRead()).toEqual({ marked: 5 });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/messages/read-all');
  });

  // 通知渠道（Task 10）：CRUD + testChannel
  it('渠道 CRUD：listChannels / createChannel / updateChannel / deleteChannel', async () => {
    const def = { id: 'ch-1', type: 'dingtalk' as const, name: '值班群', webhookUrl: 'https://oapi.dingtalk.com/robot/send', enabled: true };
    fetchMock.mockResolvedValue(jsonRes([def]));
    expect(await api.listChannels()).toEqual([def]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/notification-channels');

    fetchMock.mockResolvedValue(jsonRes({ id: 'ch-1' }, 201));
    await api.createChannel(def);
    expect(fetchMock.mock.calls[1]).toEqual(['/api/notification-channels', expect.objectContaining({ method: 'POST', body: JSON.stringify(def) })]);

    fetchMock.mockResolvedValue(jsonRes({ id: 'ch-1' }));
    await api.updateChannel('ch-1', def);
    expect(fetchMock.mock.calls[2]).toEqual(['/api/notification-channels/ch-1', expect.objectContaining({ method: 'PUT', body: JSON.stringify(def) })]);

    fetchMock.mockResolvedValue(jsonRes({ id: 'ch-1', removed: true }));
    await api.deleteChannel('ch-1');
    expect(fetchMock.mock.calls[3]).toEqual(['/api/notification-channels/ch-1', expect.objectContaining({ method: 'DELETE' })]);
  });

  it('testChannel → POST /api/notification-channels/:id/test，502 错误原样上抛', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'ch-1', sent: true }));
    expect(await api.testChannel('ch-1')).toEqual({ id: 'ch-1', sent: true });
    expect(fetchMock.mock.calls[0]).toEqual(['/api/notification-channels/ch-1/test', expect.objectContaining({ method: 'POST' })]);

    fetchMock.mockResolvedValue(jsonRes({ error: '渠道不可达: 502' }, 502));
    await expect(api.testChannel('ch-1')).rejects.toThrow('渠道不可达: 502');
  });
});
