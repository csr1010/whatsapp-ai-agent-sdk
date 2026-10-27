# @wappy_ai/productivity

The sample Gmail/Calendar assistant that ships with [Wappy](https://github.com/csr1010/whatsapp-ai-agent-sdk).
Answers any question about your Gmail or Calendar in plain language — no saved tasks, no fixed
command list, no cron, and no WhatsApp Message Template required, since every reply is a direct
response to an inbound message.

This is included automatically when you answer "yes" to the productivity question in
[`npm create @wappy_ai/agent`](https://www.npmjs.com/package/@wappy_ai/create-agent) — most people
won't install it directly.

```bash
npm install @wappy_ai/productivity
```

## How it works

Two generic, parameterized, **read-only** tools (`search_gmail`, `search_calendar`), using each
API's own real query syntax. The model builds the actual query itself from whatever was asked —
no hand-built filtering logic, no fixed list of supported questions:

- "What's on my calendar today?"
- "Find emails about the invoice from last week"
- "Summarize my unread mail by topic from the last 2 days"

It never sends an email or creates/edits/deletes an event. Not connected yet? It replies honestly
that it needs Google connected first, never a fabricated answer.

## Connecting Google

Requires [`@wappy_ai/connector-google`](https://www.npmjs.com/package/@wappy_ai/connector-google)
for the real OAuth + API calls. You bring your own Google Cloud OAuth client — connected from a
local "Connect Google" page this package serves, one click, not a CLI command.

See the [main repo](https://github.com/csr1010/whatsapp-ai-agent-sdk) for the full picture.

## License

MIT.
