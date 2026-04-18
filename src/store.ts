/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.claude-to-im/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
  CliSession,
} from 'claude-to-im/src/lib/bridge/host.js';
import type { ChannelBinding, ChannelType } from 'claude-to-im/src/lib/bridge/types.js';
import { CTI_HOME } from './config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// ── Lock entry ──

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

// ── Store ──

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  constructor(settingsMap: Map<string, string>) {
    this.settings = settingsMap;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    // Sessions
    const sessions = readJson<Record<string, BridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    for (const [id, s] of Object.entries(sessions)) {
      this.sessions.set(id, s);
    }

    // Bindings
    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'),
      {},
    );
    for (const [key, b] of Object.entries(bindings)) {
      this.bindings.set(key, b);
    }

    // Permission links
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    // Offsets
    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    // Audit
    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);
  }

  private persistSessions(): void {
    writeJson(
      path.join(DATA_DIR, 'sessions.json'),
      Object.fromEntries(this.sessions),
    );
  }

  private persistBindings(): void {
    writeJson(
      path.join(DATA_DIR, 'bindings.json'),
      Object.fromEntries(this.bindings),
    );
  }

  private persistPermissions(): void {
    writeJson(
      path.join(DATA_DIR, 'permissions.json'),
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistOffsets(): void {
    writeJson(
      path.join(DATA_DIR, 'offsets.json'),
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      path.join(DATA_DIR, 'dedup.json'),
      Object.fromEntries(this.dedupKeys),
    );
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(
      path.join(MESSAGES_DIR, `${sessionId}.json`),
      [],
    );
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  // ── Settings ──

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  // ── Channel Bindings ──

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        codepilotSessionId: data.codepilotSessionId,
        workingDirectory: data.workingDirectory,
        model: data.model,
        ...(data.agent !== undefined ? { agent: data.agent } : {}),
        ...(data.sdkSessionId !== undefined ? { sdkSessionId: data.sdkSessionId } : {}),
        ...(data.codexSessionId !== undefined ? { codexSessionId: data.codexSessionId } : {}),
        updatedAt: now(),
      };
      this.bindings.set(key, updated);
      this.persistBindings();
      return updated;
    }
    const binding: ChannelBinding = {
      id: uuid(),
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: data.sdkSessionId ?? '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (this.settings.get('bridge_default_mode') as 'code' | 'plan' | 'ask') || 'code',
      active: true,
      createdAt: now(),
      updatedAt: now(),
      ...(data.agent !== undefined ? { agent: data.agent } : {}),
      ...(data.codexSessionId !== undefined ? { codexSessionId: data.codexSessionId } : {}),
    };
    this.bindings.set(key, binding);
    this.persistBindings();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id === id) {
        this.bindings.set(key, { ...b, ...updates, updatedAt: now() });
        this.persistBindings();
        break;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(
    _name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    const session: BridgeSession = {
      id: uuid(),
      working_directory: cwd || this.settings.get('bridge_default_work_dir') || process.cwd(),
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.provider_id = providerId;
      this.persistSessions();
    }
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    msgs.push({ role, content });
    this.persistMessages(sessionId);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    // no-op for file-based store
  }

  // ── SDK Session ──

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      // Store sdkSessionId on the session object
      (s as unknown as Record<string, unknown>)['sdk_session_id'] = sdkSessionId;
      this.persistSessions();
    }
    // Also update any bindings that reference this session
    for (const [key, b] of this.bindings) {
      if (b.codepilotSessionId === sessionId) {
        this.bindings.set(key, { ...b, sdkSessionId, updatedAt: now() });
      }
    }
    this.persistBindings();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.model = model;
      this.persistSessions();
    }
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  // ── CLI Sessions ──

  private getClaudeSessionsDir(): string {
    return path.join(process.env.HOME || '', '.claude', 'sessions');
  }

  private getCodexSessionsDir(): string {
    return path.join(process.env.HOME || '', '.codex', 'sessions');
  }

  /**
   * Bridge takeover/activity files are only written for Claude CLI sessions.
   * Keep them alongside `~/.claude/sessions/*.json` so the CLI can discover them.
   */
  private getClaudeSessionArtifactsDir(): string {
    const dir = this.getClaudeSessionsDir();
    ensureDir(dir);
    return dir;
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read only the first line of a file efficiently (for JSONL session_meta).
   * Codex session_meta lines can be large (~14 KB) due to base_instructions.
   * We read in 16 KB chunks and expand if no newline is found, up to 128 KB.
   */
  private readFirstLine(filePath: string): string | null {
    try {
      const fd = fs.openSync(filePath, 'r');
      let chunkSize = 16 * 1024;
      const maxSize = 128 * 1024;
      let totalRead = 0;
      let content = '';

      while (totalRead < maxSize) {
        const buf = Buffer.alloc(chunkSize);
        const bytesRead = fs.readSync(fd, buf, 0, chunkSize, totalRead);
        if (bytesRead === 0) break;

        const chunk = buf.slice(0, bytesRead).toString('utf-8');
        content += chunk;
        totalRead += bytesRead;

        const nl = content.indexOf('\n');
        if (nl >= 0) {
          fs.closeSync(fd);
          return content.slice(0, nl);
        }
        chunkSize = Math.min(chunkSize * 2, maxSize - totalRead);
      }

      fs.closeSync(fd);
      return content || null;
    } catch {
      return null;
    }
  }

  /** Scan ~/.claude/sessions/{pid}.json for Claude Code CLI sessions. */
  private listClaudeSessions(): CliSession[] {
    const sessionsDir = this.getClaudeSessionsDir();
    try {
      const files = fs.readdirSync(sessionsDir).filter(f => /^\d+\.json$/.test(f));
      const sessions: CliSession[] = [];
      for (const file of files) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
          if (!raw.sessionId || !raw.pid) continue;
          sessions.push({
            sessionId: raw.sessionId,
            pid: raw.pid,
            cwd: raw.cwd || '',
            startedAt: raw.startedAt || 0,
            kind: raw.kind || 'interactive',
            entrypoint: raw.entrypoint || 'cli',
            isActive: this.isPidAlive(raw.pid),
            agent: 'claude',
          });
        } catch { /* skip malformed */ }
      }
      return sessions;
    } catch { return []; }
  }

  /**
   * Scan ~/.codex/sessions/{year}/{month}/{day}/rollout-*.jsonl for Codex threads.
   * Only the most recent sessions are returned (last maxDays days, up to maxTotal).
   * The first line of each JSONL file is the session_meta with thread ID and cwd.
   */
  private listCodexSessions(maxDays = 30, maxTotal = 50): CliSession[] {
    const baseDir = this.getCodexSessionsDir();
    if (!fs.existsSync(baseDir)) return [];

    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const allFiles: { filePath: string; mtime: number }[] = [];

    try {
      const years = fs.readdirSync(baseDir)
        .filter(y => /^\d{4}$/.test(y))
        .sort().reverse();

      for (const year of years) {
        if (parseInt(year) < new Date(cutoff).getFullYear() - 1) break;
        const yearDir = path.join(baseDir, year);

        const months = fs.readdirSync(yearDir)
          .filter(m => /^\d{2}$/.test(m))
          .sort().reverse();

        for (const month of months) {
          const monthDir = path.join(yearDir, month);
          const days = fs.readdirSync(monthDir)
            .filter(d => /^\d{2}$/.test(d))
            .sort().reverse();

          for (const day of days) {
            const dateTs = new Date(`${year}-${month}-${day}`).getTime();
            if (dateTs < cutoff) continue;

            const dayDir = path.join(monthDir, day);
            const files = fs.readdirSync(dayDir)
              .filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'));

            for (const file of files) {
              const filePath = path.join(dayDir, file);
              try {
                const stat = fs.statSync(filePath);
                allFiles.push({ filePath, mtime: stat.mtimeMs });
              } catch { /* skip */ }
            }
          }
        }
      }
    } catch { return []; }

    // Sort newest-first, cap at maxTotal
    allFiles.sort((a, b) => b.mtime - a.mtime);

    const sessions: CliSession[] = [];
    for (const { filePath, mtime } of allFiles.slice(0, maxTotal)) {
      try {
        const firstLine = this.readFirstLine(filePath);
        if (!firstLine) continue;

        const meta = JSON.parse(firstLine);
        if (meta.type !== 'session_meta') continue;

        const p = meta.payload;
        if (!p?.id) continue;

        sessions.push({
          sessionId: p.id,
          pid: 0,     // Codex threads have no OS-level PID to check
          cwd: p.cwd || '',
          startedAt: p.timestamp ? new Date(p.timestamp).getTime() : mtime,
          kind: 'thread',
          entrypoint: p.source || 'sdk',
          isActive: false,   // Codex threads don't expose a running PID
          agent: 'codex',
        });
      } catch { /* skip malformed */ }
    }
    return sessions;
  }

  listCliSessions(): CliSession[] {
    // Claude: all sessions with a living PID (no cap needed — usually just a handful)
    // Codex: cap at 7 days / 10 sessions to avoid flooding /sessions with history
    return [...this.listClaudeSessions(), ...this.listCodexSessions(7, 10)];
  }

  getCliSession(sessionId: string): CliSession | null {
    const sessions = this.listCliSessions();
    return sessions.find(s => s.sessionId === sessionId)
      ?? sessions.find(s => s.sessionId.startsWith(sessionId))
      ?? null;
  }

  terminateCliSession(sessionId: string): { success: boolean; reason: string } {
    const session = this.getCliSession(sessionId);
    if (!session) return { success: false, reason: 'Session not found' };
    if (!session.isActive) return { success: false, reason: 'Session is not running' };
    try {
      process.kill(session.pid, 'SIGTERM');
      return { success: true, reason: `Sent SIGTERM to PID ${session.pid}` };
    } catch (err) {
      return { success: false, reason: `Kill failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  markSessionTakenOver(
    sdkSessionId: string,
    channelType: string,
    chatId: string,
    displayName?: string,
  ): void {
    const takeoverFile = path.join(this.getClaudeSessionArtifactsDir(), `${sdkSessionId}.takeover.json`);
    try {
      fs.writeFileSync(takeoverFile, JSON.stringify({
        sdkSessionId,
        channelType,
        chatId,
        displayName,
        takenOverAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
    } catch { /* best effort */ }
  }

  recordBridgeActivity(sdkSessionId: string, responseText: string): void {
    const activityFile = path.join(this.getClaudeSessionArtifactsDir(), `${sdkSessionId}.bridge.json`);
    try {
      fs.writeFileSync(activityFile, JSON.stringify({
        sdkSessionId,
        lastActivity: new Date().toISOString(),
        lastResponseSnippet: responseText.slice(0, 200),
      }, null, 2), 'utf-8');
    } catch { /* best effort */ }
  }

  // ── Provider ──

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    // Ring buffer: keep last 1000
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    this.persistAudit();
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    // 5 minute window
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }
}
