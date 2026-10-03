# Clean Code

Universal rules to cut AI slop and keep code minimal, focused, and easy to review.

## The Problem

Most AI coding tools default to **completeness over minimality**. They tend to generate boilerplate, dead code, verbose wrappers, and long explanations—even when you only asked for the smallest working implementation. This creates "AI slop", which makes code harder to review, increases diff noise, hides bugs, and slows teams down.

This issue isn't tied to any single tool. It affects **all** major AI coding agents (Claude Code, Cursor, Cline, RooCode, Aider, Continue, Codex CLI, OpenCode, and more).

## The Solution

This is a portable set of strict, enforceable rules designed to force AI models to output **only what is necessary**. Instead of rewriting instructions for every tool you use, just paste these rules into your AI agent's custom instructions once.

## Raw Link

Use this link to copy the rules directly:

```text
https://raw.githubusercontent.com/yathaaaarth/clean-code/main/clean-code-universal.md
```

## Usage Per Tool

| Tool | Where to Add |
|---|---|
| **Claude Code** | Add to `CLAUDE.md` in your project, or use `--system-prompt-file clean-code-universal.md` |
| **Cursor** | Add as `.cursor/rules/clean-code.mdc` (set to `Always` for global enforcement) |
| **Cline / RooCode** | Paste into `Custom Instructions > System Prompt` |
| **Continue.dev** | Add as a rules block in `config.yaml` or project-level rules |
| **Aider** | Run with `--system-prompt-file=clean-code-universal.md` |
| **Codex CLI** | Add to `AGENTS.md` in your project root |
| **OpenCode** | Place in `.opencode/skills/clean-code.md` and invoke with `@skill clean-code` |

## Before vs After

**Prompt:** *"Build a simple HTML + JS counter"*

**Without these rules (AI slop):** ~40–60 lines of boilerplate, styles, comments, explanations, and maybe extra features.

**With these rules:** ~10–15 lines max. Just the minimal HTML, JS, and nothing extra.

## Philosophy

- **Review-first.** Optimize for fast code reviews, not for verbosity.
- **Minimal by default.** If it wasn't asked for, don't output it.
- **Opinionated, not dogmatic.** These rules are intentionally strict. Tweak them per project, language, or team based on your needs.
- **No installation required.** Just copy, paste, and use.