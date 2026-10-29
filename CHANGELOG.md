# Changelog

## 0.2.0 (unreleased)

### @wappy_ai/harness
- **The tool choice sees the conversation.** `createToolInvoker` now picks and fills a tool using
  the last 4 turns as well as the latest message, so a request spread over messages reaches its
  tool with all its arguments. Set `contextTurns: 0` for the old latest-message-only behaviour.
  `AgentDeps.invokeTools` receives `history` (optional, so custom hooks keep working).
- **`createAgent({ instructions })`**: an app's standing instructions, placed at the start of every
  reply's system prompt. Unset = no change.
- App settings: `WappyAppDefinition`, `resolveSettings()`, secret fields (`redactSettings()`,
  `keepSecrets()`), `Skill.respond()` and `registerApps()`.
