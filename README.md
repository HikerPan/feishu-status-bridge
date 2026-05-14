# Feishu Status Bridge

Live OpenClaw run-status cards for Feishu direct chats.

Feishu Status Bridge creates one compact interactive card when an OpenClaw agent starts working from a Feishu direct message, then keeps editing that same card as the run progresses. It is designed to answer a simple but important question: **is the agent actually doing something right now?**

The display style is inspired by Hermes Agent: short, action-oriented, icon-led, and easy to scan on mobile.

## Features

- Live Feishu status card per agent run.
- One card is edited in place instead of spamming the chat.
- Shows the active phase under `📍 当前`.
- Shows compact live counters under `📊 进度`.
- Shows currently running tools under `🛠️ 活跃工具`.
- Shows recent tool actions in a native Feishu `🧭 详情` collapsible panel.
- Marks long-running active tools as `可能卡住` after a configurable threshold.
- Replaces the final card with a compact completion summary when the run ends.
- Keeps all recent history rows by default for the current run, with an optional cap if you prefer shorter cards.
- Adds icons for common tools such as terminal, web search, browser, image generation, memory, and Feishu docs.
- Marks completed and failed tool calls with clear `✓` / `✗` indicators.
- Throttles updates to avoid hitting Feishu rate limits.
- Works on both macOS and Linux OpenClaw installs by discovering the available Feishu card runtime.

Example status text:

```text
OpenClaw 调用工具 · 14s · openai-codex/gpt-5.5
任务: 请帮我修复这个问题
📊 进度: 模型 1 · 工具 1/2 · 更新 15:36:18
📍 当前:
⚡ tool: 🖥️ exec_command("npm test")
🛠️ 活跃工具:
⏳ 🖥️ exec_command("npm test") · 4s
🧭 详情 (1)
  ✅ 🔎 tavily_search("OpenClaw plugin hooks") (1.3s) ✓
```

## Requirements

- OpenClaw with plugin support.
- A configured Feishu/Lark channel in OpenClaw.
- Node.js 20 or newer.
- Feishu direct-chat session keys in the standard OpenClaw format.

This plugin reuses OpenClaw's existing Feishu card send/edit runtime. It does not implement a separate Feishu SDK client.

## Install

Clone or copy this repository into your OpenClaw extensions directory:

```bash
mkdir -p ~/.openclaw/extensions
git clone https://github.com/HikerPan/feishu-status-bridge.git \
  ~/.openclaw/extensions/feishu-status-bridge
```

Add the plugin to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": [
      "feishu-status-bridge"
    ],
    "entries": {
      "feishu-status-bridge": {
        "enabled": true,
        "config": {
          "enabled": true,
          "minUpdateIntervalMs": 2500,
          "maxHistoryItems": 0,
          "includeToolNames": true
        },
        "hooks": {
          "allowConversationAccess": true,
          "timeouts": {
            "before_agent_reply": 10000,
            "model_call_started": 10000,
            "model_call_ended": 10000,
            "before_tool_call": 10000,
            "after_tool_call": 10000,
            "before_compaction": 10000,
            "after_compaction": 10000,
            "agent_end": 20000
          }
        }
      }
    }
  }
}
```

Restart OpenClaw:

```bash
openclaw gateway restart
```

If OpenClaw is managed by user systemd:

```bash
systemctl --user restart openclaw-gateway.service
```

## Configuration

| Option | Default | Description |
| --- | ---: | --- |
| `enabled` | `true` | Enables or disables status card publishing. |
| `minUpdateIntervalMs` | `1500` | Minimum interval between card updates. The example config uses `2500` for fewer edits. |
| `maxHistoryItems` | `0` | Maximum number of `🧭 最近` rows to keep. `0` means keep all rows for the current run. |
| `includeToolNames` | `true` | Reserved for display customization. |
| `showStats` | `true` | Shows compact model/tool/failure/update counters under `📊 进度`. |
| `showActiveTools` | `true` | Shows currently running tool calls under `🛠️ 活跃工具`. |
| `showDetailPanel` | `true` | Shows recent history in a native Feishu collapsible detail panel. |
| `detailPanelExpanded` | `false` | Opens the detail panel by default when set to `true`. |
| `stuckThresholdMs` | `60000` | Marks active tools as `可能卡住` after this many milliseconds. |
| `stuckCheckIntervalMs` | `10000` | Refreshes active-tool elapsed time and stuck status while a tool is running. |
| `showFinalSummary` | `true` | Shows a compact completion summary on the final status card. |

The plugin only publishes cards for Feishu direct chats. Group chats and non-Feishu sessions are ignored.

For very long tasks, consider setting `maxHistoryItems` to a positive number such as `20` or `50` to reduce Feishu card size. Set `showDetailPanel` to `false` if you prefer the older always-visible `🧭 最近` block.

## Runtime Discovery

Feishu Status Bridge searches for OpenClaw's Feishu card runtime in these locations:

- `FEISHU_STATUS_BRIDGE_FEISHU_DIST_DIR`
- `~/.openclaw/npm/node_modules/@openclaw/feishu/dist`
- `~/.npm-global/lib/node_modules/openclaw/dist`
- `/opt/homebrew/lib/node_modules/openclaw/dist`
- bundled OpenClaw runtimes under `~/.openclaw/extensions/*/node_modules`

If your Feishu runtime is in a custom location, set:

```bash
export FEISHU_STATUS_BRIDGE_FEISHU_DIST_DIR=/path/to/feishu/dist
```

## Verify

Run a syntax check:

```bash
npm test
```

Inspect plugin loading:

```bash
openclaw plugins inspect feishu-status-bridge
```

Check gateway logs:

```bash
journalctl --user -u openclaw-gateway.service -n 120 --no-pager | grep feishu-status-bridge
```

Expected log line:

```text
[plugins] [feishu-status-bridge] active
```

## Troubleshooting

### The plugin loads but no card appears

- Confirm the conversation is a Feishu direct chat.
- Confirm `allowConversationAccess` is enabled in the plugin hook config.
- Confirm your Feishu/OpenClaw channel can already send interactive cards.

### `Cannot locate Feishu card runtime`

Set `FEISHU_STATUS_BRIDGE_FEISHU_DIST_DIR` to the directory containing OpenClaw's Feishu `send-*.js` runtime file.

### The card updates too frequently

Increase `minUpdateIntervalMs`:

```json
{
  "minUpdateIntervalMs": 5000
}
```

### Tool lines are too verbose

The plugin intentionally clips tool arguments. If a specific tool is still noisy, add a custom mapping in `summarizeTool()`.

### The recent history section is too long

Limit the number of `🧭 最近` rows:

```json
{
  "maxHistoryItems": 20
}
```

## Security Notes

- The plugin sends task summaries and tool previews to the Feishu user who started the direct-chat run.
- Tool arguments are clipped but not fully redacted. Avoid putting secrets into prompts or tool arguments.
- Do not commit OpenClaw config files that contain tokens or account secrets.

## Development

```bash
npm test
```

The code is dependency-free and uses only Node.js built-ins plus OpenClaw's runtime-provided plugin APIs.

## License

MIT
