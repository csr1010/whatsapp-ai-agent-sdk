# @wappy_ai/create-agent

The installer for [Wappy](https://github.com/csr1010/whatsapp-ai-agent-sdk) — an open-source SDK for building
AI agents on WhatsApp. Your own model, your own number, your own data. Nothing routes through a
server we run.

## Install

```bash
npm create @wappy_ai/agent
```

A short interview (model provider, memory backend, an optional productivity agent) generates a
working project in the current directory — real code, not a template to fill in later.

```bash
cp .env.sample .env    # fill in your model key + WhatsApp creds
npm install
npm run dev             # boots the server, opens a tunnel, prints the webhook URL for Meta
```

## Non-interactive install

Every interview question has a matching flag, for CI or scripting:

```bash
npm create @wappy_ai/agent -- --yes --model anthropic --memory local --productivity no --dir my-agent
```

## What you get

- **Memory and context** — real conversation history plus a session profile (what's actually
  going on right now), not just a raw chat log.
- **A memory backend you choose** — local (SQLite, no account) or [Cognee](https://www.cognee.ai/)
  (a knowledge-graph service you bring your own instance of).
- **A routed reply** — a lightweight step decides whether a message needs a tool call or RAG
  lookup before anything expensive runs.
- **Real WhatsApp messaging** — webhook parsing, delivery retries, the 24-hour session-window
  rule, interactive replies — done for you, not left as an exercise.
- **An optional sample agent** — a Gmail/Calendar assistant, answering any question in plain
  language, read-only, no saved tasks or fixed command list.

See the [main repo README](https://github.com/csr1010/whatsapp-ai-agent-sdk) for the full pitch, and your own
generated project's `README.md`/`WHATSAPP_SETUP.md` for exact next steps once it's created.

## License

MIT.
