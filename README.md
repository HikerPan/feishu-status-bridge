# Feishu Status Bridge

OpenClaw plugin that posts one live Feishu status card for each direct-chat run, then edits the same card as the agent thinks, calls tools, compacts context, and finishes.

The card is intentionally compact and Hermes-inspired:

- `当前` shows the active phase.
- `最近` shows the latest tool/actions, one per line.
- Tool rows use icons and success/failure marks.
- Updates are throttled to avoid Feishu spam.

## Install

Copy this directory into:

```bash
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

If OpenClaw runs under systemd:

```bash
systemctl --user restart openclaw-gateway.service
```

## Runtime Lookup

The plugin reuses OpenClaw's Feishu card send/edit runtime. It searches:

- `FEISHU_STATUS_BRIDGE_FEISHU_DIST_DIR`
- `~/.openclaw/npm/node_modules/@openclaw/feishu/dist`
- `~/.npm-global/lib/node_modules/openclaw/dist`
- `/opt/homebrew/lib/node_modules/openclaw/dist`
- bundled OpenClaw runtimes inside `~/.openclaw/extensions/*/node_modules`

Set `FEISHU_STATUS_BRIDGE_FEISHU_DIST_DIR` if your Feishu runtime lives somewhere else.

## Verify

```bash
npm test
openclaw plugins inspect feishu-status-bridge
```

