# Changelog

All notable changes to Feishu Status Bridge are documented here.

## 0.4.3

- Fixed Feishu runtime discovery after an OpenClaw upgrade.
- Added fallback handling for Feishu card actions.
- Added interactive status card actions for refresh, summary, and hide.
- Added optional stop-button support through OpenClaw's built-in `/stop` command.
- Improved compatibility with macOS and Linux OpenClaw installs.

## 0.3.x

- Added secret redaction before card text is published.
- Added compact error diagnosis for failed tool calls.
- Added stuck-tool detection for long-running active tools.
- Added final summary cards when an agent run ends.
- Added collapsible Feishu detail panels for recent tool history.

## 0.2.x

- Added level-1 status-card progress details.
- Added active tool counters and recent tool rows.
- Added configurable history limits and update throttling.

## 0.1.x

- Initial OpenClaw plugin for live Feishu direct-chat status cards.
- Reused the host OpenClaw Feishu card runtime instead of shipping a separate Feishu SDK client.
