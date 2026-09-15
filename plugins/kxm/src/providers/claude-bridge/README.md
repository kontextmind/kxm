# Claude-bridge provider (vendored)

Provider-only subset of `pi-claude-bridge` 0.7.0, built into the kxm plugin.

- Upstream: [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)
- npm: `pi-claude-bridge@0.7.0`
- License: MIT, Copyright (c) 2026 Eli Dickinson — see `LICENSE`
- Author: Eli Dickinson

The Pi provider id remains `claude-bridge` so existing `claude login` /
subscription credentials carry over. This slice vendors model registration
(Opus/Sonnet/Haiku/Fable ids the plugin actually registers), Anthropic Agent
SDK streaming, thinking/effort mapping, and the in-process MCP bridge that
exposes Pi tools to Claude Code.

Not vendored here: the AskClaude tool, user-facing MCP/UI panels, TUI extras,
session JSONL rebuild (`cc-session-io`), and skills/prompt-capture forwarding.
No `@earendil-works/pi-ai` import.
