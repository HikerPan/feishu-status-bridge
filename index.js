import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_ID = "feishu-status-bridge";
const MAX_HISTORY = 4;

let feishuSendModulePromise;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(record, key) {
  const value = isRecord(record) ? record[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseFeishuDirectSessionKey(sessionKey) {
  const match = /^agent:[^:]+:feishu:direct:(ou_[A-Za-z0-9_]+)$/.exec(sessionKey ?? "");
  return match?.[1];
}

function compactElapsed(startedAt, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function timeLabel(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function clip(value, max = 64) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function resolveConfig(api, event) {
  const eventCfg = isRecord(event?.context?.pluginConfig) ? event.context.pluginConfig : undefined;
  const apiCfg = isRecord(api.pluginConfig) ? api.pluginConfig : undefined;
  const cfg = eventCfg ?? apiCfg ?? {};
  return {
    enabled: cfg.enabled !== false,
    minUpdateIntervalMs: Math.max(
      750,
      typeof cfg.minUpdateIntervalMs === "number" ? cfg.minUpdateIntervalMs : 1500
    ),
    includeToolNames: cfg.includeToolNames !== false
  };
}

function existingDirs(paths) {
  const seen = new Set();
  return paths.filter((dir) => {
    if (!dir || seen.has(dir) || !fs.existsSync(dir)) return false;
    seen.add(dir);
    return true;
  });
}

function discoverBundledRuntimeDirs(home) {
  const extensionsDir = path.join(home, ".openclaw/extensions");
  if (!fs.existsSync(extensionsDir)) return [];

  const dirs = [];
  for (const extensionName of fs.readdirSync(extensionsDir)) {
    const nodeModulesDir = path.join(extensionsDir, extensionName, "node_modules");
    if (!fs.existsSync(nodeModulesDir)) continue;

    for (const packageName of fs.readdirSync(nodeModulesDir)) {
      if (packageName === "openclaw" || packageName.startsWith("openclaw.bak.")) {
        dirs.push(path.join(nodeModulesDir, packageName, "dist"));
      }
    }
  }
  return dirs;
}

async function loadFeishuSendModule() {
  if (!feishuSendModulePromise) {
    feishuSendModulePromise = (async () => {
      const home = os.homedir();
      const candidateDirs = existingDirs([
        process.env.FEISHU_STATUS_BRIDGE_FEISHU_DIST_DIR,
        path.join(home, ".openclaw/npm/node_modules/@openclaw/feishu/dist"),
        path.join(home, ".npm-global/lib/node_modules/openclaw/dist"),
        "/opt/homebrew/lib/node_modules/openclaw/dist",
        ...discoverBundledRuntimeDirs(home)
      ]);

      const tried = [];
      for (const dir of candidateDirs) {
        if (!fs.existsSync(dir)) continue;
        const sendFiles = fs
          .readdirSync(dir)
          .filter((name) => /^send-.*\.js$/.test(name))
          .map((name) => path.join(dir, name));

        for (const file of sendFiles) {
          tried.push(file);
          const mod = await import(pathToFileURL(file).href);
          const sendCardFeishu = typeof mod.sendCardFeishu === "function" ? mod.sendCardFeishu : mod.a;
          const editMessageFeishu = typeof mod.editMessageFeishu === "function" ? mod.editMessageFeishu : mod.t;
          if (
            typeof sendCardFeishu === "function" &&
            typeof editMessageFeishu === "function" &&
            sendCardFeishu.name === "sendCardFeishu" &&
            editMessageFeishu.name === "editMessageFeishu"
          ) {
            return { sendCardFeishu, editMessageFeishu };
          }
        }
      }

      throw new Error(`Cannot locate Feishu card runtime. Tried ${tried.length ? tried.join(", ") : candidateDirs.join(", ")}`);
    })();
  }
  return feishuSendModulePromise;
}

function stateFor(states, sessionKey, ctx = {}) {
  let state = states.get(sessionKey);
  if (!state) {
    state = {
      startedAt: Date.now(),
      lastUpdatedAt: 0,
      pendingTimer: undefined,
      messageId: undefined,
      status: "运行中",
      model: undefined,
      objective: undefined,
      current: undefined,
      history: [],
      activeTools: new Map(),
      sessionKey,
      runId: ctx.runId
    };
    states.set(sessionKey, state);
  }
  if (ctx.runId) state.runId = ctx.runId;
  if (ctx.modelProviderId || ctx.modelId) {
    state.model = [ctx.modelProviderId, ctx.modelId].filter(Boolean).join("/");
  }
  return state;
}

function pushHistory(state, text) {
  const normalized = clip(text, 96);
  if (!normalized) return;
  if (state.history[state.history.length - 1] === normalized) return;
  state.history.push(normalized);
  while (state.history.length > MAX_HISTORY) state.history.shift();
}

function setCurrent(state, kind, detail) {
  state.current = {
    at: timeLabel(),
    kind,
    detail: clip(detail, 96)
  };
}

function iconForTool(name) {
  const icons = {
    exec_command: "🖥️",
    write_stdin: "⌨️",
    apply_patch: "✏️",
    web_search: "🔎",
    tavily_search: "🔎",
    tavily_extract: "📄",
    browser: "🌐",
    image: "🖼️",
    image_generate: "🎨",
    vision_analyze: "👁️",
    feishu_doc: "📝",
    feishu_bitable_list_records: "📊",
    memory_search: "🧠",
    skill_view: "📚",
    todo: "☑️",
    execute_code: "⚙️",
    terminal: "🖥️"
  };
  return icons[name] ?? "⚡";
}

function iconForKind(kind) {
  const icons = {
    request: "📥",
    model: "🤔",
    tool: "⚡",
    thinking: "🤔",
    compact: "🧹",
    done: "✅",
    error: "⚠️"
  };
  return icons[kind] ?? "•";
}

function formatTrailLine(entry) {
  if (!entry) return "";
  if (isRecord(entry)) {
    const icon = entry.icon || iconForKind(entry.kind);
    return `${icon} ${entry.text ?? `${entry.kind}: ${entry.detail ?? ""}`}`.trim();
  }
  return String(entry);
}

function summarizeTool(event) {
  const name = readString(event, "toolName") ?? readString(event, "name") ?? "tool";
  const params = isRecord(event?.params) ? event.params : {};
  if (name.startsWith("_")) return "";

  const primaryArgs = {
    exec_command: "cmd",
    write_stdin: "chars",
    apply_patch: "patch",
    web_search: "query",
    tavily_search: "query",
    tavily_extract: "urls",
    browser: "url",
    image: "prompt",
    image_generate: "prompt",
    vision_analyze: "question",
    feishu_doc: "action",
    feishu_bitable_list_records: "table_id",
    memory_search: "query",
    skill_view: "name",
    todo: "todos",
    execute_code: "code",
    terminal: "command"
  };

  if (name === "todo" && Array.isArray(params.todos)) {
    return `${iconForTool(name)} todo("${params.merge ? "updating" : "planning"} ${params.todos.length} task(s)")`;
  }

  const key = primaryArgs[name] ?? ["query", "text", "cmd", "command", "path", "name", "prompt", "code", "goal", "url"]
    .find((candidate) => candidate in params);
  if (!key) return name;

  let value = params[key];
  if (Array.isArray(value)) value = value[0] ?? "";
  const preview = clip(value, 64);
  if (preview) return `${iconForTool(name)} ${name}("${preview}")`;
  return `${iconForTool(name)} ${name}`;
}

function formatStatus(state) {
  const header = [
    `OpenClaw ${state.status}`,
    compactElapsed(state.startedAt),
    state.model ? clip(state.model, 36) : undefined
  ].filter(Boolean);

  const currentLine = state.current
    ? `📍 当前:\n${iconForKind(state.current.kind)} ${state.current.kind}: ${state.current.detail}`
    : "📍 当前:\n• 等待运行事件";
  const historyBlock = state.history.length
    ? ["🧭 最近:", ...state.history.map(formatTrailLine)].join("\n")
    : undefined;

  return [
    header.join(" · "),
    state.objective ? `任务: ${clip(state.objective, 80)}` : undefined,
    currentLine,
    historyBlock
  ].filter(Boolean).join("\n");
}

function completeTool(state, event) {
  const id = event?.toolCallId;
  const started = id ? state.activeTools.get(id) : undefined;
  const label = started?.label || summarizeTool(event);
  if (!label) return;

  if (id) state.activeTools.delete(id);
  const duration = typeof event?.durationMs === "number" ? ` (${(event.durationMs / 1000).toFixed(1)}s)` : "";
  const icon = event?.error ? "❌" : "✅";
  const mark = event?.error ? "✗" : "✓";
  pushHistory(state, `${icon} ${label}${duration} ${mark}`);
}

function statusTemplate(status) {
  if (status === "失败" || status === "工具报错") return "red";
  if (status === "完成") return "green";
  if (status === "调用工具") return "wathet";
  return "blue";
}

function statusTitle(status) {
  const labels = {
    "运行中": "Working",
    "思考中": "Thinking",
    "调用工具": "Tool Running",
    "继续处理": "Working",
    "工具报错": "Tool Error",
    "压缩上下文": "Compacting",
    "恢复处理": "Resuming",
    "完成": "Done",
    "失败": "Failed"
  };
  return `OpenClaw ${labels[status] ?? status}`;
}

function resetTurnState(state) {
  state.startedAt = Date.now();
  state.lastUpdatedAt = 0;
  state.messageId = undefined;
  state.status = "运行中";
  state.current = undefined;
  state.history = [];
  state.activeTools = new Map();
  state.objective = undefined;
}

function shouldDisplayTool(label) {
  return Boolean(label && !label.startsWith("_") && !label.startsWith("message("));
}

function noteModel(state, event, phase) {
  state.model = event?.resolvedRef ?? [event?.provider, event?.model].filter(Boolean).join("/") ?? state.model;
  if (phase === "start") setCurrent(state, "model", clip(state.model || "started", 64));
}

function buildMarkdownStatus(state) {
  return [
    `**${statusTitle(state.status)}**`,
    formatStatus(state)
  ].join("\n");
}

function buildStatusCard(state) {
  const title = statusTitle(state.status);
  return {
    schema: "2.0",
    config: {
      width_mode: "fill"
    },
    header: {
      template: statusTemplate(state.status),
      title: {
        tag: "plain_text",
        content: title
      }
    },
    body: {
      elements: [{
        tag: "markdown",
        content: buildMarkdownStatus(state)
      }]
    }
  };
}

async function upsertStatusMessage(api, state, openId) {
  const cfg = api.runtime.config.current();
  const { sendCardFeishu, editMessageFeishu } = await loadFeishuSendModule();
  const card = buildStatusCard(state);

  if (!state.messageId) {
    const result = await sendCardFeishu({
      cfg,
      to: `user:${openId}`,
      card,
      accountId: "default"
    });
    state.messageId = result?.messageId;
    return;
  }

  try {
    await editMessageFeishu({
      cfg,
      messageId: state.messageId,
      card,
      accountId: "default"
    });
  } catch (error) {
    api.logger?.warn?.(`[${PLUGIN_ID}] edit failed, sending a replacement status message: ${String(error)}`);
    state.messageId = undefined;
    const result = await sendCardFeishu({
      cfg,
      to: `user:${openId}`,
      card,
      accountId: "default"
    });
    state.messageId = result?.messageId;
  }
}

async function publish(api, states, ctx, event, options = {}) {
  const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
  const openId = parseFeishuDirectSessionKey(sessionKey);
  if (!sessionKey || !openId) return;

  const cfg = resolveConfig(api, event);
  if (!cfg.enabled) return;

  const state = stateFor(states, sessionKey, ctx);
  const now = Date.now();
  const force = options.force === true || options.terminal === true || !state.messageId;

  if (!force && now - state.lastUpdatedAt < cfg.minUpdateIntervalMs) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = setTimeout(() => {
      publish(api, states, ctx, event, { force: true }).catch((error) => {
        api.logger?.warn?.(`[${PLUGIN_ID}] delayed publish failed: ${String(error)}`);
      });
    }, cfg.minUpdateIntervalMs);
    return;
  }

  clearTimeout(state.pendingTimer);
  state.pendingTimer = undefined;

  try {
    await upsertStatusMessage(api, state, openId);
    state.lastUpdatedAt = Date.now();
  } catch (error) {
    api.logger?.warn?.(`[${PLUGIN_ID}] publish failed: ${String(error)}`);
  }
}

function clearState(states, sessionKey) {
  const state = states.get(sessionKey);
  if (state?.pendingTimer) clearTimeout(state.pendingTimer);
  states.delete(sessionKey);
}

export default {
  id: PLUGIN_ID,
  name: "Feishu Status Bridge",
  description: "Shows OpenClaw run lifecycle and tool progress in Feishu direct chats by editing one live status message.",
  register(api) {
    const states = new Map();

    api.on("gateway_start", () => {
      api.logger?.info?.(`[${PLUGIN_ID}] active`);
    });

    api.on("before_agent_reply", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const state = stateFor(states, sessionKey, ctx);
      resetTurnState(state);
      state.objective = clip(event?.cleanedBody ?? "收到消息", 80);
      setCurrent(state, "request", "received");
      await publish(api, states, ctx, event, { force: true });
    }, { priority: 40, timeoutMs: 10000 });

    api.on("model_call_started", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const state = stateFor(states, sessionKey, ctx);
      state.status = "思考中";
      noteModel(state, event, "start");
      await publish(api, states, ctx, event);
    }, { timeoutMs: 10000 });

    api.on("model_call_ended", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const state = stateFor(states, sessionKey, ctx);
      noteModel(state, event, "end");
      await publish(api, states, ctx, event);
    }, { timeoutMs: 10000 });

    api.on("before_tool_call", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const state = stateFor(states, sessionKey, ctx);
      const label = summarizeTool(event);
      if (!shouldDisplayTool(label)) return;
      state.status = "调用工具";
      if (event?.toolCallId) {
        state.activeTools.set(event.toolCallId, { label, startedAt: Date.now() });
      }
      setCurrent(state, "tool", label);
      await publish(api, states, ctx, event);
    }, { priority: 40, timeoutMs: 10000 });

    api.on("after_tool_call", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const state = stateFor(states, sessionKey, ctx);
      state.status = event?.error ? "工具报错" : "继续处理";
      completeTool(state, event);
      if (state.activeTools.size === 0) {
        setCurrent(state, event?.error ? "error" : "thinking", event?.error ? clip(event.error, 96) : "waiting for next step");
      }
      await publish(api, states, ctx, event);
    }, { timeoutMs: 10000 });

    api.on("before_compaction", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const state = stateFor(states, sessionKey, ctx);
      state.status = "压缩上下文";
      setCurrent(state, "compact", "summarizing context");
      await publish(api, states, ctx, event, { force: true });
    }, { timeoutMs: 10000 });

    api.on("after_compaction", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const state = stateFor(states, sessionKey, ctx);
      state.status = "恢复处理";
      pushHistory(state, "compact ✓");
      setCurrent(state, "model", "resuming");
      await publish(api, states, ctx, event, { force: true });
    }, { timeoutMs: 10000 });

    api.on("agent_end", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const state = stateFor(states, sessionKey, ctx);
      state.status = event?.success === false ? "失败" : "完成";
      const duration = typeof event?.durationMs === "number" ? `${Math.round(event.durationMs / 1000)}s` : compactElapsed(state.startedAt);
      setCurrent(state, state.status === "完成" ? "done" : "error", event?.error ? clip(event.error, 96) : `total ${duration}`);
      await publish(api, states, ctx, event, { terminal: true });
      clearState(states, sessionKey);
    }, { timeoutMs: 20000 });
  }
};
