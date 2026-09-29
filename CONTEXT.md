# Project glossary

- **Clip gain** — The audio level adjustment stored in milli-decibels. Zero means unchanged level; mute is a separate track state.
- **AI account sign-in** — Connecting a Claude plan account (not an API key) through Anthropic's PKCE paste-code flow. Tokens live only in the OS keyring and never cross IPC; native code refreshes them and calls the Messages API with them. Starting sign-in requires an explicit terms-risk acknowledgement. See `docs/features/ai-account-sign-in.md`.
- **Audio fades** — Linear-amplitude fade-in and fade-out durations measured in sequence frames of the clip's output timeline, after speed conversion. Their combined duration cannot exceed the clip duration; zero fades mean no envelope.
