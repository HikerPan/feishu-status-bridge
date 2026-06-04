# Security Policy

## Supported Versions

The `main` branch is the currently supported development line. Tagged releases receive best-effort fixes when maintainers can reproduce the issue.

## Reporting a Vulnerability

Please report security issues privately to the maintainer instead of opening a public issue with exploit details.

Include:

- A short description of the vulnerability.
- The affected OpenClaw and Feishu Status Bridge versions.
- Minimal reproduction steps.
- Any logs or card output with secrets removed.

## Security Design Notes

Feishu Status Bridge publishes task summaries and clipped tool previews only to the Feishu direct-chat user who started the run. The plugin performs best-effort redaction for common secrets, API keys, tokens, emails, phone numbers, and sensitive URL query parameters before publishing card text.

Redaction is not a substitute for operational hygiene. Avoid putting secrets in prompts, tool arguments, issue descriptions, or logs that may be displayed in a status card.
