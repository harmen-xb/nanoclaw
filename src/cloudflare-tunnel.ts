import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

export interface CloudflareTunnelOpts {
  tunnelName: string;
  tunnelId: string;
  subdomain: string;
  domain: string;
  port: number;
  cloudflaredBin?: string; // path to cloudflared binary, defaults to searching PATH + /tmp
}

export class CloudflareTunnel {
  private proc: ChildProcess | null = null;
  private opts: CloudflareTunnelOpts;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: CloudflareTunnelOpts) {
    this.opts = opts;
  }

  get url(): string {
    return `https://${this.opts.subdomain}.${this.opts.domain}`;
  }

  private findCloudflared(): string {
    if (this.opts.cloudflaredBin && fs.existsSync(this.opts.cloudflaredBin)) {
      return this.opts.cloudflaredBin;
    }
    // Common locations
    const candidates = [
      'cloudflared',           // in PATH
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
      '/tmp/cloudflared',
      path.join(os.homedir(), '.local/bin/cloudflared'),
    ];
    for (const bin of candidates) {
      try {
        if (bin === 'cloudflared' || fs.existsSync(bin)) return bin;
      } catch { /* skip */ }
    }
    return 'cloudflared'; // fallback — will fail with a clear error
  }

  private getConfigPath(): string {
    return path.join(os.homedir(), '.cloudflared', 'config.yml');
  }

  private ensureConfig(): void {
    const configPath = this.getConfigPath();
    const configDir = path.dirname(configPath);
    fs.mkdirSync(configDir, { recursive: true });

    const credFile = path.join(configDir, `${this.opts.tunnelId}.json`);
    const config = [
      `tunnel: ${this.opts.tunnelId}`,
      `credentials-file: ${credFile}`,
      '',
      'ingress:',
      `  - hostname: ${this.opts.subdomain}.${this.opts.domain}`,
      `    service: http://localhost:${this.opts.port}`,
      `  - service: http_status:404`,
      '',
    ].join('\n');

    fs.writeFileSync(configPath, config, 'utf-8');
    logger.debug({ configPath }, 'Cloudflare tunnel config written');
  }

  start(): void {
    if (this.stopped) return;
    this.ensureConfig();

    const bin = this.findCloudflared();
    const args = ['tunnel', '--config', this.getConfigPath(), 'run', this.opts.tunnelName];

    logger.info({ bin, tunnelName: this.opts.tunnelName, url: this.url }, 'Starting Cloudflare tunnel');

    this.proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) logger.debug({ tunnel: this.opts.tunnelName }, `cloudflared: ${line}`);
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;
      if (line.includes('Registered tunnel connection')) {
        logger.info({ tunnelName: this.opts.tunnelName, url: this.url }, 'Cloudflare tunnel connected');
        console.log(`\n  Cloudflare tunnel: ${this.url}\n`);
      } else if (line.includes('ERR') || line.includes('error')) {
        logger.warn({ tunnel: this.opts.tunnelName }, `cloudflared: ${line}`);
      } else {
        logger.debug({ tunnel: this.opts.tunnelName }, `cloudflared: ${line}`);
      }
    });

    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      if (this.stopped) return;
      logger.warn({ code, signal, tunnelName: this.opts.tunnelName }, 'Cloudflare tunnel exited, restarting in 5s');
      this.restartTimer = setTimeout(() => this.start(), 5000);
    });

    this.proc.on('error', (err) => {
      logger.error({ err, tunnelName: this.opts.tunnelName }, 'Cloudflare tunnel process error');
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      logger.info({ tunnelName: this.opts.tunnelName }, 'Stopping Cloudflare tunnel');
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }
}
