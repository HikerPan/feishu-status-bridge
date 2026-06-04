# Contributing

Thanks for helping improve Feishu Status Bridge.

## Development

Use Node.js 20 or newer.

```bash
npm test
```

The current test script runs a syntax check for the dependency-free plugin entrypoint. More fixture-based tests are planned in the roadmap.

## Pull Requests

Please keep changes focused and include:

- The OpenClaw version or package layout you tested with.
- Whether the run started from a Feishu/Lark direct chat.
- Any relevant card output with secrets removed.
- Notes about rate-limit, privacy, or compatibility impact.

## Issues

Bug reports are most useful when they include:

- OpenClaw version.
- Node.js version.
- Operating system.
- Plugin config.
- The relevant gateway log lines with tokens and account identifiers removed.
