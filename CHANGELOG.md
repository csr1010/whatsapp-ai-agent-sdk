# Changelog

## 0.2.0 (unreleased)

### @wappy_ai/harness
- **Hybrid recall.** `createKnowledge({ embed, hybrid: true })` ranks by keywords and vectors and merges
  the two by position, so one search finds exact codes and names as well as paraphrases and other
  languages. Without `hybrid`, recall behaves as before.
- **The tool choice sees the conversation.** `createToolInvoker` now picks and fills a tool using
  the last 4 turns as well as the latest message, so a request spread over messages reaches its
  tool with all its arguments. Set `contextTurns: 0` for the old latest-message-only behaviour.
  `AgentDeps.invokeTools` receives `history` (optional, so custom hooks keep working). The choice
  now also sees each candidate tool's description and parameters, so arguments use the tool's own names.
- **A valid reply is no longer thrown away** when only the extras around it (session facts, the
  format rationale) don't validate — the reply is sent and the bad extras are dropped.
- **The options a reply offered are remembered:** a reply's buttons and list rows are kept in the
  conversation history, numbered, alongside its text — so "1", "the second one" or a typed button
  title on the next turn has something to point at.
- **A reply over a channel limit is fitted, not lost:** more than 3 buttons or 10 list rows are cut to
  the first ones; an interactive part that can't be fitted is dropped and the text is sent.
- **Confirm-before-write is guarded by code:** a tool isn't run or offered for confirmation while a
  required argument is missing (the reply asks for it), and a confirmation requested this turn always
  reaches the person as Confirm / Cancel buttons, even if the model's reply left them out.
- **`createAgent({ instructions })`**: an app's standing instructions, placed at the start of every
  reply's system prompt. Unset = no change.
- App settings: `WappyAppDefinition`, `resolveSettings()`, secret fields (`redactSettings()`,
  `keepSecrets()`), `Skill.respond()` and `registerApps()`.
