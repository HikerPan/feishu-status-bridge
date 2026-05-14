import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_ID = "feishu-status-bridge";
const COMMAND_NAME = "fsb";
const COMMAND_USAGE = "Usage: /fsb status|refresh|summary|hide <token>";

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

function encodeActionToken(sessionKey) {
  return Buffer.from(String(sessionKey ?? ""), "utf8").toString("base64url");
}

function decodeActionToken(token) {
  try {
    const decoded = Buffer.from(String(token ?? ""), "base64url").toString("utf8");
    return parseFeishuDirectSessionKey(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
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
  const text = redactSensitive(value).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function redactSensitive(value) {
  let text = String(value ?? "");
  text = text.replace(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{8,})\b/g, "sk-[redacted]");
  text = text.replace(/\b(gh[opsu]_[A-Za-z0-9_]{8,})\b/g, "ghp_[redacted]");
  text = text.replace(/\b(glpat-[A-Za-z0-9_-]{8,})\b/g, "glpat-[redacted]");
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  text = text.replace(
    /\b((?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|GH_TOKEN|FEISHU_APP_SECRET|LARK_APP_SECRET|API_KEY|TOKEN|PASSWORD|PASSWD|SECRET)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    "$1[redacted]"
  );
  text = text.replace(
    /(\b--?(?:password|passwd|token|secret|api-key|apikey|key)\b(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    "$1[redacted]"
  );
  text = redactUrlSecrets(text);
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]");
  text = text.replace(/(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)/g, "[phone]");
  return text;
}

function redactUrlSecrets(text) {
  return text.replace(/([?&](?:token|access_token|refresh_token|key|api_key|apikey|password|passwd|secret)=)[^&#\s]+/gi, "$1[redacted]");
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
    maxHistoryItems: Number.isInteger(cfg.maxHistoryItems) && cfg.maxHistoryItems > 0 ? cfg.maxHistoryItems : 0,
    includeToolNames: cfg.includeToolNames !== false,
    showStats: cfg.showStats !== false,
    showActiveTools: cfg.showActiveTools !== false,
    showDetailPanel: cfg.showDetailPanel !== false,
    detailPanelExpanded: cfg.detailPanelExpanded === true,
    stuckThresholdMs: Math.max(
      5000,
      typeof cfg.stuckThresholdMs === "number" ? cfg.stuckThresholdMs : 60000
    ),
    stuckCheckIntervalMs: Math.max(
      1000,
      typeof cfg.stuckCheckIntervalMs === "number" ? cfg.stuckCheckIntervalMs : 10000
    ),
    showFinalSummary: cfg.showFinalSummary !== false,
    showActionButtons: cfg.showActionButtons === true,
    showStopButton: cfg.showStopButton === true,
    actionStateTtlMs: Math.max(
      60000,
      typeof cfg.actionStateTtlMs === "number" ? cfg.actionStateTtlMs : 60 * 60000
    )
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
      activeToolTimer: undefined,
      cleanupTimer: undefined,
      messageId: undefined,
      hidden: false,
      terminal: false,
      status: "运行中",
      model: undefined,
      objective: undefined,
      current: undefined,
      history: [],
      activeTools: new Map(),
      finalSummary: undefined,
      lastErrorSummary: undefined,
      stats: createStats(),
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

function createStats() {
  return {
    modelCalls: 0,
    toolCallsStarted: 0,
    toolsCompleted: 0,
    toolsFailed: 0,
    compactions: 0,
    lastEventAt: undefined
  };
}

function markEvent(state) {
  if (!state.stats) state.stats = createStats();
  state.stats.lastEventAt = timeLabel();
}

function pushHistory(state, text, maxHistoryItems = 0) {
  const normalized = clip(text, 96);
  if (!normalized) return;
  if (state.history[state.history.length - 1] === normalized) return;
  state.history.push(normalized);
  if (maxHistoryItems > 0) {
    while (state.history.length > maxHistoryItems) state.history.shift();
  }
}

function clearTimers(state) {
  if (state?.pendingTimer) clearTimeout(state.pendingTimer);
  if (state?.activeToolTimer) clearTimeout(state.activeToolTimer);
  if (state?.cleanupTimer) clearTimeout(state.cleanupTimer);
  if (!state) return;
  state.pendingTimer = undefined;
  state.activeToolTimer = undefined;
  state.cleanupTimer = undefined;
}

function setCurrent(state, kind, detail) {
  state.current = {
    at: timeLabel(),
    kind,
    detail: clip(detail, 96)
  };
  markEvent(state);
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
    terminal: "🖥️",
    message: "💬",
    tts: "🔊"
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
    return `${icon} ${redactSensitive(entry.text ?? `${entry.kind}: ${entry.detail ?? ""}`)}`.trim();
  }
  return redactSensitive(entry);
}

function safeUrlSummary(value) {
  const input = Array.isArray(value) ? value[0] : value;
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return redactUrlSecrets(`${url.hostname}${url.pathname === "/" ? "" : url.pathname}`);
  } catch {
    return clip(raw, 64);
  }
}

function summarizeCommand(cmd) {
  const text = redactSensitive(cmd);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "run command";
  const gitMatch = /^git\s+([a-z-]+)/.exec(normalized);
  if (gitMatch) return `git ${gitMatch[1]}`;
  const npmMatch = /^(npm|pnpm|yarn)\s+([^\s]+)/.exec(normalized);
  if (npmMatch) return `${npmMatch[1]} ${npmMatch[2]}`;
  const first = normalized.split(/\s+/)[0];
  return first ? `run ${first}` : "run command";
}

function toolDisplayName(name) {
  const names = {
    exec_command: "shell",
    write_stdin: "terminal input",
    apply_patch: "edit files",
    web_search: "web search",
    tavily_search: "web search",
    tavily_extract: "extract page",
    browser: "browser",
    image: "analyze image",
    image_generate: "generate image",
    vision_analyze: "analyze image",
    feishu_doc: "Feishu doc",
    feishu_bitable_list_records: "Feishu table",
    memory_search: "memory search",
    skill_view: "read skill",
    todo: "plan tasks",
    execute_code: "run code",
    terminal: "terminal",
    message: "send message",
    tts: "voice reply"
  };
  return names[name] ?? name.replace(/^_+/, "").replace(/_/g, " ");
}

function formatToolLabel(name, detail, cfg = {}) {
  const icon = iconForTool(name);
  const displayName = cfg.includeToolNames === false ? toolDisplayName(name) : name;
  return detail ? `${icon} ${displayName}("${clip(detail, 64)}")` : `${icon} ${displayName}`;
}

function summarizePatch(value) {
  const text = String(value ?? "");
  const files = [];
  for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    files.push(path.basename(match[1].trim()));
  }
  if (files.length) return `patch ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}`;
  return "apply patch";
}

function summarizeTool(event, cfg = {}) {
  const name = readString(event, "toolName") ?? readString(event, "name") ?? "tool";
  const params = isRecord(event?.params) ? event.params : {};
  if (name.startsWith("_")) return "";

  if (name === "message") return `${iconForTool(name)} ${cfg.includeToolNames === false ? "send message" : "message"}`;
  if (name === "tts") return `${iconForTool(name)} ${cfg.includeToolNames === false ? "voice reply" : "tts"}`;
  if (name === "exec_command") return formatToolLabel(name, summarizeCommand(params.cmd ?? params.command), cfg);
  if (name === "terminal") return formatToolLabel(name, summarizeCommand(params.command ?? params.cmd), cfg);
  if (name === "apply_patch") return formatToolLabel(name, summarizePatch(params.patch ?? params.text ?? event?.input), cfg);
  if (name === "browser") return formatToolLabel(name, `${params.action ?? "act"} ${safeUrlSummary(params.url ?? params.targetUrl)}`.trim(), cfg);
  if (name === "tavily_extract") return formatToolLabel(name, safeUrlSummary(params.urls), cfg);
  if (name === "feishu_doc") return formatToolLabel(name, params.action ?? "document", cfg);

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
    return formatToolLabel(name, `${params.merge ? "updating" : "planning"} ${params.todos.length} task(s)`, cfg);
  }

  const key = primaryArgs[name] ?? ["query", "text", "cmd", "command", "path", "name", "prompt", "code", "goal", "url"]
    .find((candidate) => candidate in params);
  if (!key) return formatToolLabel(name, "", cfg);

  let value = params[key];
  if (Array.isArray(value)) value = value[0] ?? "";
  return formatToolLabel(name, value, cfg);
}

function formatStatus(state) {
  const header = [
    `OpenClaw ${effectiveStatus(state)}`,
    compactElapsed(state.startedAt),
    state.model ? clip(state.model, 36) : undefined
  ].filter(Boolean);

  const currentLine = state.current
    ? `📍 当前 (${state.current.at}):\n${iconForKind(state.current.kind)} ${state.current.kind}: ${state.current.detail}`
    : "📍 当前:\n• 等待运行事件";
  const statsLine = state.showStats === false ? undefined : formatStats(state);
  const activeToolsBlock = state.showActiveTools === false ? undefined : formatActiveTools(state);
  const historyBlock = state.history.length
    ? ["🧭 最近:", ...state.history.map(formatTrailLine)].join("\n")
    : undefined;

  return [
    header.join(" · "),
    state.objective ? `任务: ${clip(state.objective, 80)}` : undefined,
    statsLine,
    state.finalSummary,
    currentLine,
    activeToolsBlock,
    state.showDetailPanel === false ? historyBlock : undefined
  ].filter(Boolean).join("\n");
}

function formatStats(state) {
  const stats = state.stats ?? createStats();
  const parts = [
    `模型 ${stats.modelCalls}`,
    `工具 ${stats.toolsCompleted}/${stats.toolCallsStarted}`
  ];
  if (stats.toolsFailed > 0) parts.push(`失败 ${stats.toolsFailed}`);
  if (stats.compactions > 0) parts.push(`压缩 ${stats.compactions}`);
  if (stats.lastEventAt) parts.push(`更新 ${stats.lastEventAt}`);
  return `📊 进度: ${parts.join(" · ")}`;
}

function formatFinalSummary(state, duration) {
  const stats = state.stats ?? createStats();
  const icon = state.status === "完成" ? "✅" : "❌";
  const parts = [
    `总耗时 ${duration}`,
    `模型 ${stats.modelCalls}`,
    `工具 ${stats.toolsCompleted}/${stats.toolCallsStarted}`
  ];
  if (stats.toolsFailed > 0) parts.push(`失败 ${stats.toolsFailed}`);
  if (stats.compactions > 0) parts.push(`压缩 ${stats.compactions}`);
  const last = state.history.length ? `\n最后动作: ${formatTrailLine(state.history[state.history.length - 1])}` : "";
  const error = state.lastErrorSummary ? `\n错误诊断: ${state.lastErrorSummary}` : "";
  return `${icon} 完成摘要: ${parts.join(" · ")}${last}${error}`;
}

function formatTextSummary(state) {
  if (!state) return "没有找到这次运行的状态记录。";
  return [
    `OpenClaw ${effectiveStatus(state)} · ${compactElapsed(state.startedAt)}`,
    state.objective ? `任务: ${clip(state.objective, 120)}` : undefined,
    formatStats(state),
    state.finalSummary,
    state.current ? `当前: ${iconForKind(state.current.kind)} ${state.current.kind}: ${state.current.detail}` : undefined,
    state.activeTools?.size ? formatActiveTools(state) : undefined,
    state.history.length ? ["最近动作:", ...state.history.map(formatTrailLine)].join("\n") : undefined
  ].filter(Boolean).join("\n");
}

function formatActiveTools(state) {
  if (!state.activeTools?.size) return undefined;
  const lines = [];
  const now = Date.now();
  const threshold = state.stuckThresholdMs ?? 60000;
  for (const tool of state.activeTools.values()) {
    const elapsedMs = tool.startedAt ? now - tool.startedAt : 0;
    const elapsed = tool.startedAt ? compactElapsed(tool.startedAt, now) : "";
    const stuck = elapsedMs >= threshold;
    lines.push(`${stuck ? "⚠️" : "⏳"} ${tool.label}${elapsed ? ` · ${elapsed}` : ""}${stuck ? " · 可能卡住" : ""}`);
  }
  return ["🛠️ 活跃工具:", ...lines].join("\n");
}

function hasStuckTools(state, now = Date.now()) {
  if (!state.activeTools?.size) return false;
  const threshold = state.stuckThresholdMs ?? 60000;
  for (const tool of state.activeTools.values()) {
    if (tool.startedAt && now - tool.startedAt >= threshold) return true;
  }
  return false;
}

function effectiveStatus(state) {
  if (state.status === "调用工具" && hasStuckTools(state)) return "可能卡住";
  return state.status;
}

function formatHistoryPanel(state) {
  if (!state.history.length || state.showDetailPanel === false) return undefined;
  return {
    tag: "collapsible_panel",
    expanded: state.detailPanelExpanded === true,
    header: {
      title: {
        tag: "plain_text",
        content: `🧭 详情 (${state.history.length})`
      },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "16px 16px"
      },
      icon_position: "right",
      icon_expanded_angle: -180
    },
    border: {
      color: "grey",
      corner_radius: "5px"
    },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{
      tag: "markdown",
      content: state.history.map(formatTrailLine).join("\n")
    }]
  };
}

function buildFeishuCardButton(params) {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: params.label
    },
    type: params.type ?? "default",
    value: {
      text: params.command
    }
  };
}

function buildActionButtons(state) {
  if (state.showActionButtons === false || state.hidden) return undefined;
  const token = encodeActionToken(state.sessionKey);
  const actions = [
    buildFeishuCardButton({
      label: "刷新状态",
      type: "primary",
      command: `/${COMMAND_NAME} refresh ${token}`
    }),
    buildFeishuCardButton({
      label: "查看摘要",
      command: `/${COMMAND_NAME} summary ${token}`
    }),
    buildFeishuCardButton({
      label: "隐藏卡片",
      command: `/${COMMAND_NAME} hide ${token}`
    })
  ];
  if (state.showStopButton === true && state.terminal !== true) {
    actions.push(buildFeishuCardButton({
      label: "停止任务",
      type: "danger",
      command: "/stop"
    }));
  }
  return {
    tag: "action",
    actions
  };
}

function buildHiddenCard(state) {
  return {
    schema: "2.0",
    config: {
      width_mode: "fill"
    },
    header: {
      template: "grey",
      title: {
        tag: "plain_text",
        content: "OpenClaw Status Hidden"
      }
    },
    body: {
      elements: [{
        tag: "markdown",
        content: `状态卡已隐藏 · ${compactElapsed(state.startedAt)}\n后续运行不会再刷新这张卡。`
      }]
    }
  };
}

function compactError(value) {
  if (!value) return "";
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    return value.message ?? value.stderr ?? value.error ?? value.code ?? JSON.stringify(value);
  }
  return String(value);
}

function classifyError(text) {
  const value = text.toLowerCase();
  if (/auth|unauthori[sz]ed|forbidden|permission|credential|token|api key|401|403/.test(value)) return "认证/权限";
  if (/enotfound|econn|network|timed out|timeout|dns|socket|http 5\d\d/.test(value)) return "网络";
  if (/enoent|no such file|not found|cannot find|path/.test(value)) return "路径/文件";
  if (/exit code|command failed|non-zero|failed/.test(value)) return "命令失败";
  return "运行错误";
}

function summarizeError(event) {
  const code = event?.exitCode ?? event?.code ?? event?.result?.exitCode;
  const failedExit = typeof code === "number" ? code !== 0 : Boolean(code && code !== "0");
  if (!event?.error && !event?.result?.error && !failedExit) return "";
  const raw = compactError(event?.error ?? event?.result?.error ?? event?.stderr ?? event?.result?.stderr);
  const text = clip(raw, 120);
  if (!text) return "";
  const codePart = code !== undefined && code !== null ? `exit ${code} · ` : "";
  return `${codePart}${classifyError(text)} · ${text}`;
}

function completeTool(state, event, cfg) {
  const id = event?.toolCallId;
  const started = id ? state.activeTools.get(id) : undefined;
  const label = started?.label || summarizeTool(event, cfg);
  if (!label) return;

  if (id) state.activeTools.delete(id);
  state.stats.toolsCompleted += 1;
  const errorSummary = summarizeError(event);
  if (event?.error || errorSummary) {
    state.stats.toolsFailed += 1;
    state.lastErrorSummary = errorSummary;
  }
  markEvent(state);
  const duration = typeof event?.durationMs === "number" ? ` (${(event.durationMs / 1000).toFixed(1)}s)` : "";
  const failed = Boolean(event?.error || errorSummary);
  const icon = failed ? "❌" : "✅";
  const mark = failed ? "✗" : "✓";
  const suffix = failed && errorSummary ? ` · ${errorSummary}` : "";
  pushHistory(state, `${icon} ${label}${duration} ${mark}${suffix}`, cfg.maxHistoryItems);
}

function statusTemplate(status) {
  if (status === "可能卡住") return "yellow";
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
    "可能卡住": "Possibly Stuck",
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
  clearTimers(state);
  state.messageId = undefined;
  state.hidden = false;
  state.terminal = false;
  state.status = "运行中";
  state.current = undefined;
  state.history = [];
  state.activeTools = new Map();
  state.finalSummary = undefined;
  state.lastErrorSummary = undefined;
  state.stats = createStats();
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
  const status = effectiveStatus(state);
  return [
    `**${statusTitle(status)}**`,
    formatStatus(state)
  ].join("\n");
}

function buildStatusCard(state, options = {}) {
  if (state.hidden) return buildHiddenCard(state);
  const status = effectiveStatus(state);
  const title = statusTitle(status);
  const elements = [{
    tag: "markdown",
    content: buildMarkdownStatus(state)
  }];
  const historyPanel = formatHistoryPanel(state);
  if (historyPanel) elements.push(historyPanel);
  const actionButtons = options.omitActionButtons === true ? undefined : buildActionButtons(state);
  if (actionButtons) elements.push(actionButtons);

  return {
    schema: "2.0",
    config: {
      width_mode: "fill"
    },
    header: {
      template: statusTemplate(status),
      title: {
        tag: "plain_text",
        content: title
      }
    },
    body: {
      elements
    }
  };
}

function scheduleActiveToolMonitor(api, states, ctx, event, state, cfg) {
  if (state.activeToolTimer) clearTimeout(state.activeToolTimer);
  state.activeToolTimer = undefined;
  if (!state.activeTools?.size) return;

  const now = Date.now();
  let nextDelay = cfg.stuckCheckIntervalMs;
  for (const tool of state.activeTools.values()) {
    if (!tool.startedAt) continue;
    const untilStuck = cfg.stuckThresholdMs - (now - tool.startedAt);
    if (untilStuck > 0) nextDelay = Math.min(nextDelay, untilStuck);
  }
  nextDelay = Math.max(1000, nextDelay);

  state.activeToolTimer = setTimeout(() => {
    publish(api, states, ctx, event, { force: true }).catch((error) => {
      api.logger?.warn?.(`[${PLUGIN_ID}] active tool monitor publish failed: ${String(error)}`);
    });
  }, nextDelay);
}

async function upsertStatusMessage(api, state, openId) {
  const cfg = api.runtime.config.current();
  const { sendCardFeishu, editMessageFeishu } = await loadFeishuSendModule();
  let card = buildStatusCard(state, { omitActionButtons: state.actionButtonsUnsupported === true });

  if (!state.messageId) {
    let result;
    try {
      result = await sendCardFeishu({
        cfg,
        to: `user:${openId}`,
        card,
        accountId: "default"
      });
    } catch (error) {
      if (!isUnsupportedActionCardError(error) || state.actionButtonsUnsupported === true) throw error;
      state.actionButtonsUnsupported = true;
      api.logger?.warn?.(`[${PLUGIN_ID}] Feishu Card 2.0 rejected action buttons; retrying without buttons.`);
      card = buildStatusCard(state, { omitActionButtons: true });
      result = await sendCardFeishu({
        cfg,
        to: `user:${openId}`,
        card,
        accountId: "default"
      });
    }
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
    if (isUnsupportedActionCardError(error) && state.actionButtonsUnsupported !== true) {
      state.actionButtonsUnsupported = true;
      api.logger?.warn?.(`[${PLUGIN_ID}] Feishu Card 2.0 rejected action buttons; retrying edit without buttons.`);
      await editMessageFeishu({
        cfg,
        messageId: state.messageId,
        card: buildStatusCard(state, { omitActionButtons: true }),
        accountId: "default"
      });
      return;
    }
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

function isUnsupportedActionCardError(error) {
  const text = compactError(error);
  return /unsupported tag action|schema V2 no longer support this capability|ErrCode:\s*200861/i.test(text);
}

async function publish(api, states, ctx, event, options = {}) {
  const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
  const openId = parseFeishuDirectSessionKey(sessionKey);
  if (!sessionKey || !openId) return;

  const cfg = resolveConfig(api, event);
  if (!cfg.enabled) return;

  const state = stateFor(states, sessionKey, ctx);
  if (state.hidden && options.force !== true && options.terminal !== true) return;
  state.showStats = cfg.showStats;
  state.showActiveTools = cfg.showActiveTools;
  state.showDetailPanel = cfg.showDetailPanel;
  state.detailPanelExpanded = cfg.detailPanelExpanded;
  state.stuckThresholdMs = cfg.stuckThresholdMs;
  state.stuckCheckIntervalMs = cfg.stuckCheckIntervalMs;
  state.showFinalSummary = cfg.showFinalSummary;
  state.showActionButtons = cfg.showActionButtons;
  state.showStopButton = cfg.showStopButton;
  state.actionStateTtlMs = cfg.actionStateTtlMs;
  const now = Date.now();
  const force = options.force === true || options.terminal === true || !state.messageId;

  const elapsedSinceUpdate = now - state.lastUpdatedAt;
  if (!force && state.messageId && elapsedSinceUpdate < cfg.minUpdateIntervalMs) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = setTimeout(() => {
      publish(api, states, ctx, event, { force: true }).catch((error) => {
        api.logger?.warn?.(`[${PLUGIN_ID}] delayed publish failed: ${String(error)}`);
      });
    }, cfg.minUpdateIntervalMs - elapsedSinceUpdate);
    return;
  }

  clearTimeout(state.pendingTimer);
  state.pendingTimer = undefined;

  try {
    await upsertStatusMessage(api, state, openId);
    state.lastUpdatedAt = Date.now();
    if (!state.hidden) scheduleActiveToolMonitor(api, states, ctx, event, state, cfg);
  } catch (error) {
    api.logger?.warn?.(`[${PLUGIN_ID}] publish failed: ${String(error)}`);
  }
}

function clearState(states, sessionKey) {
  const state = states.get(sessionKey);
  clearTimers(state);
  states.delete(sessionKey);
}

function scheduleStateCleanup(states, sessionKey, ttlMs) {
  const state = states.get(sessionKey);
  if (!state) return;
  if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
  state.cleanupTimer = setTimeout(() => clearState(states, sessionKey), ttlMs);
}

async function handleCommand(api, states, ctx) {
  const tokens = (ctx.args?.trim() ?? "").split(/\s+/).filter(Boolean);
  const action = (tokens[0] ?? "status").toLowerCase();
  if (action === "help") return { text: COMMAND_USAGE };

  const tokenSessionKey = decodeActionToken(tokens[1]);
  const sessionKey = tokenSessionKey ?? ctx.CommandTargetSessionKey ?? ctx.sessionKey ?? ctx.SessionKey;
  const state = sessionKey ? states.get(sessionKey) : undefined;

  if (action === "status") {
    return { text: state ? formatTextSummary(state) : "当前没有可用的 Feishu Status Bridge 运行状态。" };
  }

  if (!state || !sessionKey) {
    return { text: "没有找到这张状态卡对应的运行记录，可能已经过期或 Gateway 刚重启过。" };
  }

  if (action === "refresh") {
    await publish(api, states, { sessionKey, runId: state.runId }, { sessionKey }, { force: true });
    return { text: "已刷新状态卡。" };
  }

  if (action === "summary") {
    return { text: formatTextSummary(state) };
  }

  if (action === "hide") {
    state.hidden = true;
    clearTimers(state);
    await publish(api, states, { sessionKey, runId: state.runId }, { sessionKey }, { force: true });
    return { text: "已隐藏状态卡，后续不会再刷新。" };
  }

  return { text: COMMAND_USAGE };
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
      state.stats.modelCalls += 1;
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
      const cfg = resolveConfig(api, event);
      const state = stateFor(states, sessionKey, ctx);
      const label = summarizeTool(event, cfg);
      if (!shouldDisplayTool(label)) return;
      state.status = "调用工具";
      state.stats.toolCallsStarted += 1;
      markEvent(state);
      if (event?.toolCallId) {
        state.activeTools.set(event.toolCallId, { label, startedAt: Date.now() });
      }
      setCurrent(state, "tool", label);
      await publish(api, states, ctx, event);
    }, { priority: 40, timeoutMs: 10000 });

    api.on("after_tool_call", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const cfg = resolveConfig(api, event);
      const state = stateFor(states, sessionKey, ctx);
      state.status = event?.error ? "工具报错" : "继续处理";
      completeTool(state, event, cfg);
      if (state.activeTools.size === 0) {
        setCurrent(state, event?.error ? "error" : "thinking", event?.error ? summarizeError(event) : "waiting for next step");
      }
      await publish(api, states, ctx, event);
    }, { timeoutMs: 10000 });

    api.on("before_compaction", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const state = stateFor(states, sessionKey, ctx);
      state.status = "压缩上下文";
      state.stats.compactions += 1;
      setCurrent(state, "compact", "summarizing context");
      await publish(api, states, ctx, event, { force: true });
    }, { timeoutMs: 10000 });

    api.on("after_compaction", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const cfg = resolveConfig(api, event);
      const state = stateFor(states, sessionKey, ctx);
      state.status = "恢复处理";
      pushHistory(state, "compact ✓", cfg.maxHistoryItems);
      setCurrent(state, "model", "resuming");
      await publish(api, states, ctx, event, { force: true });
    }, { timeoutMs: 10000 });

    api.on("agent_end", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
      if (!parseFeishuDirectSessionKey(sessionKey)) return;
      const cfg = resolveConfig(api, event);
      const state = stateFor(states, sessionKey, ctx);
      state.status = event?.success === false ? "失败" : "完成";
      const duration = typeof event?.durationMs === "number" ? `${Math.round(event.durationMs / 1000)}s` : compactElapsed(state.startedAt);
      state.activeTools.clear();
      if (cfg.showFinalSummary !== false) state.finalSummary = formatFinalSummary(state, duration);
      setCurrent(state, state.status === "完成" ? "done" : "error", event?.error ? summarizeError(event) : `total ${duration}`);
      state.terminal = true;
      await publish(api, states, ctx, event, { terminal: true });
      if (state.showActionButtons === false) clearState(states, sessionKey);
      else {
        clearTimers(state);
        scheduleStateCleanup(states, sessionKey, state.actionStateTtlMs ?? 60 * 60000);
      }
    }, { timeoutMs: 20000 });

    api.registerCommand({
      name: COMMAND_NAME,
      description: "Control Feishu Status Bridge status cards.",
      acceptsArgs: true,
      handler: async (ctx) => handleCommand(api, states, ctx)
    });
  }
};
