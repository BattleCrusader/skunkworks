/**
 * The app's end of `run/plugin.sock` (§8.3, §8.4; S4d).
 *
 * One persistent unix-socket connection per app process. Frames are JSON lines in both
 * directions:
 *
 *   app -> runner   `{id, op, plugin, tenant?, args}`      one request, one reply
 *   runner -> app   `{type: 'host.call', id, tenant, plugin, op, args}`
 *   app -> runner   `{type: 'host.result', id, ok, result|code, message}`
 *
 * The plugin's own code reaches a host op through `child.mjs`'s `skw.call()`, which the
 * runner forwards on the connection that requested the invoke — so the tenant is bound
 * by the *caller*, never by a field a plugin controls (§8.3: "a tenant field in a
 * payload is ignored and logged"). The app answers from `<data>/tenants/<key>/site.db`
 * with an `admin-write` connection, and only after `assertEnabled()` has read the
 * tenant's own `cms_plugin_installed` row.
 *
 * When the socket is absent, `connect()` returns false and every call refuses
 * `SKW_E_PL_UNAVAILABLE`: a box with no runner serves pages, it just cannot ship a
 * plugin, and that is the honest shape of the feature (§13.3).
 */
import { connect, type Socket } from 'node:net';

import type Database from 'better-sqlite3';

import { openAdminWrite } from '../db/classes.ts';
import { assertEnabled } from './install.ts';
import { hostOp, type HostCall } from './ops.ts';

export interface PluginSummary {
  id: string;
  version: string;
  ready: boolean;
  capabilities: string[];
}

export interface PluginHostOptions {
  socketPath: string;
  /** `<data>`; the tenant databases live at `<data>/tenants/<key>/site.db`. */
  dataDir: string;
  emailMode: 'off' | 'smtp';
  /** One line per host op, for the operator and for the gate. Off by default. */
  log: ((line: string) => void) | undefined;
  /** §15.3: one plugin RPC has 5 s end to end (2 s in the runner, 2 s here). */
  timeoutMs?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const UNAVAILABLE = 'SKW_E_PL_UNAVAILABLE';

export class PluginHost {
  private socket: Socket | null = null;
  /** The socket whose `close` handler is allowed to clear state (see `onClose`). */
  private closing: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly options: PluginHostOptions;
  private connected = false;

  constructor(options: PluginHostOptions) {
    this.options = options;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  /**
   * Connect and wait for the runner's socket. `false` is not an error: a host install
   * without the runner container is a supported shape, and every plugin call then says
   * exactly why it cannot be answered.
   */
  async connect(): Promise<boolean> {
    if (this.connected) return true;
    return await new Promise<boolean>((resolve) => {
      const socket = connect(this.options.socketPath);
      const fail = (): void => {
        socket.destroy();
        this.socket = null;
        this.connected = false;
        resolve(false);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.removeListener('error', fail);
        this.socket = socket;
        this.closing = socket;
        this.connected = true;
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.onData(chunk));
        socket.on('error', (err) => this.onClose(err));
        socket.on('close', () => this.onClose(new Error('the plugin runner closed the channel')));
        resolve(true);
      });
    });
  }

  private onClose(err: Error): void {
    // A socket that has already been replaced by a reconnect must not clear the new one: the
    // runner is restarted by the operator after an install (`skwctl plugin install` says so),
    // and the old channel's `close` arrives *after* the new one is bound.
    if (this.closing !== null && this.socket !== this.closing) return;
    this.closing = null;
    this.connected = false;
    this.socket = null;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      this.pending.delete(id);
      waiter.reject(new Error(`${UNAVAILABLE}: plugin runner channel closed: ${err.message}`));
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (line.trim() === '') continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message.type === 'host.call') {
        // Not awaited: the socket must keep reading while the host op runs.
        void this.answerHostCall(message);
        continue;
      }
      const id = typeof message.id === 'number' ? message.id : null;
      if (id === null) continue;
      const waiter = this.pending.get(id);
      if (waiter === undefined) continue;
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      if (message.ok === true) waiter.resolve(message.result ?? null);
      else waiter.reject(new Error(`${String(message.code ?? 'SKW_E_PL_PLUGIN_ERROR')}: ${String(message.message ?? '')}`));
    }
  }

  /** Execute one host op and answer on the same channel. Never throws into the reader. */
  private async answerHostCall(message: Record<string, unknown>): Promise<void> {
    const id = String(message.id ?? '');
    const tenant = typeof message.tenant === 'string' ? message.tenant : '';
    const plugin = typeof message.plugin === 'string' ? message.plugin : '';
    const op = typeof message.op === 'string' ? message.op : '';
    const args = typeof message.args === 'object' && message.args !== null ? (message.args as Record<string, unknown>) : {};
    const reply = (body: Record<string, unknown>): void => {
      this.socket?.write(`${JSON.stringify({ type: 'host.result', id, ...body })}\n`);
    };
    let db: Database.Database | null = null;
    try {
      const call: HostCall = { tenant, plugin, op, args };
      db = openAdminWrite(`${this.options.dataDir}/tenants/${call.tenant}/site.db`, 5000);
      const row = assertEnabled(db, plugin);
      if (!row.manifest.capabilities.includes(op)) {
        throw new Error(`SKW_E_PL_REJECTED: ${op} is not in ${plugin}'s declared capabilities`);
      }
      const result = hostOp({ db, tenant, plugin, manifest: row.manifest, emailMode: this.options.emailMode }, op, args);
      this.options.log?.(`host op ${op} plugin=${plugin} tenant=${tenant} ok`);
      reply({ ok: true, result: result ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /^(SKW_E_[A-Z0-9_]+)/.exec(message)?.[1] ?? 'SKW_E_PL_UNAVAILABLE';
      this.options.log?.(`host op ${op} plugin=${plugin} tenant=${tenant} refused ${message}`);
      reply({ ok: false, code, message });
    } finally {
      db?.close();
    }
  }

  private async request(payload: Record<string, unknown>): Promise<unknown> {
    if (this.socket === null || !this.connected) {
      // S4e: reconnect on demand. The runner is restarted whenever a package is installed or
      // removed (`skwctl` says "restart the runner service to load …"), and an app that only
      // connects at boot would answer PL_UNAVAILABLE for every plugin until *it* was
      // restarted too — the "install → enable → it works" path, broken by one restart.
      const bound = await this.connect();
      if (!bound) {
        throw new Error(`${UNAVAILABLE}: the plugin runner is not bound (${this.options.socketPath})`);
      }
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${UNAVAILABLE}: plugin op ${String(payload.op)} exceeded ${this.options.timeoutMs ?? 5000} ms`));
      }, this.options.timeoutMs ?? 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket?.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  async list(): Promise<PluginSummary[]> {
    const result = await this.request({ op: 'plugin.list' });
    return Array.isArray(result) ? (result as PluginSummary[]) : [];
  }

  /**
   * Run one package entrypoint. `tenant` is the app's binding, and the runner forwards
   * every host op the package makes during this call back to this connection.
   *
   * `grant` is the capability set the tenant's installed row carries, and the runner
   * refuses anything outside it before asking the host. The caller that already read the
   * row passes it (`endpoint.ts` does); a caller that did not gets the row read here, and a
   * package with no row gets the **empty** grant — never the manifest's, because "no row"
   * and "every capability" must not be the same request.
   */
  async invoke(
    tenant: string,
    plugin: string,
    op: string,
    args: Record<string, unknown> = {},
    grant?: readonly string[],
  ): Promise<unknown> {
    const granted = grant ?? this.grantFor(tenant, plugin);
    return await this.request({ op: 'plugin.invoke', plugin, tenant, granted: [...granted], args: { op, args } });
  }

  /**
   * The grant as the tenant's own database states it. Read-only and tolerant: an absent
   * table, an absent row or an unreadable file is the empty set, which the runner treats as
   * "no host op", and the host's own check refuses the op with the row's own reason.
   */
  private grantFor(tenant: string, plugin: string): readonly string[] {
    let db: Database.Database | null = null;
    try {
      db = openAdminWrite(`${this.options.dataDir}/tenants/${tenant}/site.db`, 5000);
      const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`).get();
      if (table === undefined) return [];
      const row = db.prepare('SELECT manifest_json FROM cms_plugin_installed WHERE plugin_id = ?').get(plugin) as
        | { manifest_json: string }
        | undefined;
      if (row === undefined) return [];
      const manifest = JSON.parse(row.manifest_json) as { capabilities?: unknown };
      return Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [];
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  close(): void {
    this.closing = null;
    this.socket?.end();
    this.socket = null;
    this.connected = false;
  }
}
