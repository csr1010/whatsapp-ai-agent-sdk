# @wappy_ai/whatsapp

A real WhatsApp Cloud API integration, for [Wappy](https://github.com/csr1010/whatsapp-ai-agent-sdk): webhook
signature verification and parsing, message rendering, delivery retries, and the 24-hour
session-window rule — the parts of WhatsApp integration that are easy to get subtly wrong, done
once and correctly.

Most people won't install this directly — it comes in automatically via
[`npm create @wappy_ai/agent`](https://www.npmjs.com/package/@wappy_ai/create-agent). It's useful
on its own if you're wiring WhatsApp into something outside the generated scaffold.

```bash
npm install @wappy_ai/whatsapp
```

## What's in here

- **`createWhatsAppChannel`** — a real `MessageChannel` implementation, sending text, buttons,
  lists, and media via the WhatsApp Cloud API.
- **`createWebhookServer`** — a plain `node:http` server that verifies Meta's webhook signature and
  parses inbound messages.
- **Session-window handling** — tracks whether a contact's 24-hour free-form messaging window is
  open, and falls back to a Message Template when it isn't.
- **Delivery retries and media handling** — built in, not left for you to implement.

You'll need your own WhatsApp Cloud API app (free, via
[Meta's developer portal](https://developers.facebook.com/apps)) — this package never operates a
shared app on your behalf.

See the [main repo](https://github.com/csr1010/whatsapp-ai-agent-sdk) for the full picture.

## License

MIT.
