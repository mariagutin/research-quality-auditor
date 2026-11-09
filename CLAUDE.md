# CLAUDE.md

Project guidance for Claude Code working in this repository.

## Architecture decisions

Read every ADR in docs/adr before making changes, and write a new ADR for every big decision.

## Working with Maria (learning preferences)

Maria is learning development. In this repository:

- **Verify before instructing.** Before giving setup instructions, commands, or tool
  steps, check them against current official documentation rather than memory. Prefer
  official sources and note when something may have changed.
- **Explain each step.** Say what each command or step does in plain language, and
  state clearly whether it changes, creates, or deletes anything.
- **Go one step at a time, for all work** (not only installs and setup). Explain one
  topic at a time and wait for Maria to say "next" before continuing.
- **Lead with a short overview.** When a task is complete, present the result in a brief
  overview of no more than five sentences, then explain one topic at a time as above.
  Keep detailed technical results in the project documentation, not the chat.
- **Test migrations locally first.** Use a disposable local database and synthetic data.
  Apply migrations to hosted Supabase only when Maria explicitly authorizes it. Do not
  run local test scripts against hosted or use real research data for testing.
- **Never commit or push** unless explicitly told to, and only the files named.
