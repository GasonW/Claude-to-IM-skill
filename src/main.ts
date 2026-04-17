/**
 * Daemon entry point for claude-to-im-skill.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import * as bridgeManager from 'claude-to-im/src/lib/bridge/bridge-manager.js';
// Side-effect import to trigger adapter self-registration
import 'claude-to-im/src/lib/bridge/adapters/index.js';
import './adapters/weixin-adapter.js';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import { loadConfig, configToSettings, CTI_HOME } from './config.js';
import type { Config } from './config.js';
import { JsonFileStore } from './store.js';
import { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

// ── Multi-agent routing provider ─────────────────────────────────────────────

/**
 * Routes each streamChat call to the correct underlying provider based on
 * params.agent ('claude' | 'codex').  This is what enables per-binding
 * agent switching via /agent and /switch without restarting the daemon.
 *
 * Codex provider is lazily imported so missing @openai/codex-sdk is only
 * a hard error if/when a Codex session is actually used.
 */
class RoutingLLMProvider implements LLMProvider {
  private codexProvider: LLMProvider | null = null;

  constructor(
    private readonly claudeProvider: LLMProvider | null,
    private readonly defaultAgent: 'claude' | 'codex',
    private readonly pendingPerms: PendingPermissions,
  ) {}

  private getOrInitCodexProvider(): LLMProvider {
    if (!this.codexProvider) {
      // @openai/codex-sdk is optional; the dynamic require must be sync here
      // because streamChat returns a ReadableStream, not a Promise.
      // CodexProvider's ensureSDK() is async internally — we just create
      // the instance (no I/O at construction time).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CodexProvider } = require('./codex-provider.js');
      this.codexProvider = new CodexProvider(this.pendingPerms);
      console.log('[routing-llm] Codex provider initialised');
    }
    return this.codexProvider!;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const agent = params.agent || this.defaultAgent;

    if (agent === 'codex') {
      console.log(
        `[routing-llm] → Codex  session=${params.sessionId.slice(0, 8)} ` +
        `thread=${params.codexSessionId?.slice(0, 12) ?? 'new'}`,
      );
      return this.getOrInitCodexProvider().streamChat(params);
    }

    if (this.claudeProvider) {
      console.log(
        `[routing-llm] → Claude session=${params.sessionId.slice(0, 8)} ` +
        `sdk=${params.sdkSessionId?.slice(0, 12) ?? 'new'}`,
      );
      return this.claudeProvider.streamChat(params);
    }

    // Claude requested but not available (CTI_RUNTIME=codex)
    console.error('[routing-llm] Claude provider not available (CTI_RUNTIME=codex)');
    const { sseEvent } = require('./sse-utils.js');
    return new ReadableStream({
      start(controller) {
        controller.enqueue(sseEvent('error', 'Claude provider not available. Set CTI_RUNTIME=claude or CTI_RUNTIME=auto.'));
        controller.close();
      },
    });
  }
}

// ── Provider resolution ───────────────────────────────────────────────────────

/**
 * Build the LLM provider based on the runtime setting.
 * Always returns a RoutingLLMProvider so /agent switching works at runtime.
 *
 * - 'claude' (default): Claude is primary; Codex initialised lazily on first use
 * - 'codex': Codex is primary; Claude provider is null (returns error if used)
 * - 'auto': tries Claude first, falls back to Codex as primary
 */
async function resolveProvider(config: Config, pendingPerms: PendingPermissions): Promise<LLMProvider> {
  const runtime = config.runtime;

  if (runtime === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    const codex = new CodexProvider(pendingPerms);
    // No Claude provider in pure-codex mode
    return new RoutingLLMProvider(null, 'codex', pendingPerms);
  }

  if (runtime === 'auto') {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        const claude = new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
        return new RoutingLLMProvider(claude, 'claude', pendingPerms);
      }
      console.warn(
        `[claude-to-im] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
        `  Falling back to Codex.`,
      );
    } else {
      console.log('[claude-to-im] Auto: Claude CLI not found, falling back to Codex');
    }
    const { CodexProvider } = await import('./codex-provider.js');
    const codex = new CodexProvider(pendingPerms);
    return new RoutingLLMProvider(null, 'codex', pendingPerms);
  }

  // Default: claude — Claude is primary, Codex available lazily
  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    console.error(
      '[claude-to-im] FATAL: Cannot find the `claude` CLI executable.\n' +
      '  Tried: CTI_CLAUDE_CODE_EXECUTABLE env, /usr/local/bin/claude, /opt/homebrew/bin/claude, ~/.npm-global/bin/claude, ~/.local/bin/claude\n' +
      '  Fix: Install Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code) or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude\n' +
      '  Or: Set CTI_RUNTIME=codex to use Codex instead',
    );
    process.exit(1);
  }

  const check = preflightCheck(cliPath);
  if (check.ok) {
    console.log(`[claude-to-im] CLI preflight OK: ${cliPath} (${check.version})`);
  } else {
    console.error(
      `[claude-to-im] FATAL: Claude CLI preflight check failed.\n` +
      `  Path: ${cliPath}\n` +
      `  Error: ${check.error}\n` +
      `  Fix:\n` +
      `    1. Install Claude Code CLI >= 2.x: https://docs.anthropic.com/en/docs/claude-code\n` +
      `    2. Or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/correct/claude\n` +
      `    3. Or set CTI_RUNTIME=auto to fall back to Codex`,
    );
    process.exit(1);
  }

  const claude = new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
  return new RoutingLLMProvider(claude, 'claude', pendingPerms);
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[claude-to-im] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  const pendingPerms = new PendingPermissions();
  const llm = await resolveProvider(config, pendingPerms);
  console.log(`[claude-to-im] Runtime: ${config.runtime}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
        });
        console.log(`[claude-to-im] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[claude-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[claude-to-im] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[claude-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[claude-to-im] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[claude-to-im] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[claude-to-im] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[claude-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
