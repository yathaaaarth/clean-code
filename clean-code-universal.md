# Clean Code Universal Rules

## Core Principle
Write the **absolute minimum** code required to solve the exact problem. Optimize for **readability and fast code reviews**, not for showing off.

## General Rules
- **Only output what was asked.** Don't add extra features, utilities, or "nice to have" code.
- **No AI self-talk.** Never explain, summarize, justify, or say "Here is..." outside of code blocks.
- **Code only in code blocks.** If the user didn't explicitly ask for text/explanation, don't output any.
- **Smallest viable diff.** Only modify files that are directly relevant to the request.
- **Match existing codebase style.** Follow indentation, naming, imports, and conventions already present.
- **Don't invent dependencies.** Only use libraries/frameworks that already exist in the project.

## Code Quality Rules
- **No dead code.** Remove any unused imports, variables, functions, classes, styles, or constants.
- **No boilerplate.** Avoid empty files, default exports you don't need, getters/setters, or template fluff.
- **No placeholders.** Don't add `// TODO`, `// FIXME`, or stub functions unless explicitly requested.
- **Minimal naming.** Use short, meaningful names. Avoid over-descriptive or generic names like `dataObject`, `myFunction`, etc.
- **Avoid over-abstraction.** Don't create interfaces, types, enums, or helper functions unless they're actually used.
- **Keep logic obvious.** Write straightforward code. Avoid clever one-liners that hurt readability.
- **Use built-ins.** Prefer native APIs over writing custom wrappers.
- **Handle only what's needed.** Add error handling, validation, or edge cases **only** if the user explicitly asks for them.

## Comments & Clarity
- **Comment only when non-obvious.** Skip comments for trivial things (`i++`, `return result`).
- **Keep comments brief.** Use short, inline comments or 1-line explanations. No long paragraphs.
- **Explain "why", not "what".** If you must comment, focus on the reasoning behind a weird workaround or constraint.

## Output Discipline
- **No test files unless asked.** Don't generate unit tests, integration tests, or mocks unprompted.
- **No config files unless asked.** Skip `.json`, `.config`, `.env.example`, etc unless explicitly requested.
- **No markdown docs unless asked.** Don't create `README.md`, `CHANGELOG.md`, or comments in markdown form.
- **No CSS resets/global styles unless asked.** Only write the CSS needed for the requested element/component.
- **No console.logs/debuggers.** Remove all `console.log`, `print`, `debugger`, or similar debug statements.
- **No commented-out code.** Delete old or alternate implementations entirely.

## Final Check
Before returning output, ask yourself: *"If I were reviewing this diff, would I be annoyed by any of this?"* If yes, cut it.