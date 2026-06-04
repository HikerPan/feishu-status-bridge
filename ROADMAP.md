# Roadmap

Feishu Status Bridge is early but usable. The next maintenance priorities are:

## Reliability

- Add fixture-based tests for OpenClaw hook payload shapes.
- Add regression coverage for Feishu card action fallback behavior.
- Keep runtime discovery compatible with OpenClaw package layout changes.

## Security and Privacy

- Expand secret-redaction test cases.
- Add opt-in strict mode for hiding tool arguments by default.
- Document safe deployment patterns for team Feishu/Lark workspaces.

## User Experience

- Add screenshot or GIF examples of the live status card lifecycle.
- Improve human-readable tool labels.
- Add clearer failure states for missing Feishu runtime configuration.

## Packaging

- Publish signed GitHub releases.
- Consider an installation script once OpenClaw plugin packaging conventions stabilize.
- Track compatibility with OpenClaw releases in the README.
