# @wappy_ai/harness

The agent itself, for [Wappy](https://github.com/csr1010/whatsapp-ai-agent-sdk): routing, memory, session
profile, local RAG, and reply-format reasoning. Bring your own model — it works with any provider
the [Vercel AI SDK](https://sdk.vercel.ai/) supports (OpenAI, Anthropic, Gemini, local Ollama).

Most people won't install this directly — it comes in automatically via
[`npm create @wappy_ai/agent`](https://www.npmjs.com/package/@wappy_ai/create-agent), which wires
it up for you. It's useful on its own if you're composing an agent by hand instead of using the
generated scaffold.

```bash
npm install @wappy_ai/harness
```

## What's in here

- **`createAgent`** — the core loop: routes a message, decides whether it needs RAG or a tool,
  composes a reply, and formats it.
- **Memory** (`createLibsqlMemory`) — real per-contact conversation history, local by default.
- **Session profile** — what's actually going on right now for a contact, kept up to date on every
  turn, not just a raw message log.
- **Knowledge/RAG** (`createKnowledge`, `createKnowledgeRag`) — local keyword/BM25 search by
  default, or swap in a different backend (e.g.
  [`@wappy_ai/connector-cognee`](https://www.npmjs.com/package/@wappy_ai/connector-cognee)) that
  implements the same `Knowledge` interface.
- **Tools** (`createToolInvoker`) — picks the one tool a message needs and fills its arguments,
  looking at the last few turns too (`contextTurns`, default 4), so a request spread over messages
  ("book a visit to X" → "Saturday" → "Ravi") still reaches its tool with everything said. Tools
  marked `confirmBefore` wait for a Confirm tap.
- **Standing instructions** (`createAgent({ instructions })`) — who your agent is, how it talks and
  what it always needs to know, at the start of every reply's prompt.
- **Router** (`createLlmRouter`) — a lightweight classification step that decides whether a
  message needs a tool call, RAG lookup, or neither, before anything expensive runs.

See the [main repo](https://github.com/csr1010/whatsapp-ai-agent-sdk) for the full picture.

## License

MIT.
