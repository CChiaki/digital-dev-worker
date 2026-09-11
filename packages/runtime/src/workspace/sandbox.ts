import type { SandboxBackend } from './types.js';

/**
 * 沙箱三档（spec 4.7 执行层硬防线）：同一 wrap(argv) 契约，部署档位互换。
 * 白名单校验始终针对原始命令（backend 只加壳不改语义）。
 */

/** 直跑档：试点机/单测默认（软防线已挡危险命令，硬防线留待部署接入） */
export class NoopBackend implements SandboxBackend {
  readonly name = 'noop';
  wrap(argv: string[]): string[] {
    return argv;
  }
}

/** bubblewrap 系统级沙箱：只读根 + 工作区可写 + tmpfs /tmp + 封 HOME + 默认断网 + pid 隔离。
 *  net=true 才放开网络（构建类任务需要拉包时按任务开）。 */
export class BwrapBackend implements SandboxBackend {
  readonly name = 'bwrap';
  private readonly workspace: string;
  private readonly net: boolean;

  constructor(opts: { workspace: string; net?: boolean }) {
    this.workspace = opts.workspace;
    this.net = opts.net ?? false;
  }

  wrap(argv: string[]): string[] {
    return [
      'bwrap',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/etc', '/etc',
      '--proc', '/proc',
      '--dev', '/dev',
      '--bind', this.workspace, '/workspace',
      '--tmpfs', '/tmp',
      '--setenv', 'HOME', '/workspace',
      ...(this.net ? [] : ['--unshare-net']),
      '--unshare-pid',
      '--chdir', '/workspace',
      '--',
      ...argv,
    ];
  }
}

/** 容器档：预起常驻容器，命令经 docker exec 进容器执行（workdir=容器内工作区挂载点） */
export class DockerBackend implements SandboxBackend {
  readonly name = 'docker';
  private readonly container: string;
  private readonly workdir: string;

  constructor(opts: { container: string; workdir?: string }) {
    this.container = opts.container;
    this.workdir = opts.workdir ?? '/workspace';
  }

  wrap(argv: string[]): string[] {
    return ['docker', 'exec', '--workdir', this.workdir, this.container, ...argv];
  }
}
