# @wappy_ai/connector-google

Bring-your-own Google Cloud OAuth, for
[`@wappy_ai/productivity`](https://www.npmjs.com/package/@wappy_ai/productivity)'s Gmail/Calendar
assistant in [Wappy](https://github.com/csr1010/whatsapp-ai-agent-sdk). Real, parameterized Calendar and Gmail
search — no fabricated data, no shared Wappy-operated Google app.

Included automatically when you answer "yes" to the productivity question in
[`npm create @wappy_ai/agent`](https://www.npmjs.com/package/@wappy_ai/create-agent) — most people
won't install it directly.

```bash
npm install @wappy_ai/connector-google
```

## What's in here

- **OAuth** — your own Google Cloud OAuth client, connected via a local "Connect Google" page, one
  click, not a CLI command or a credential typed into this package.
- **Calendar + Gmail search** — real API calls using each service's own query syntax, read-only.
- **Token storage** — a small local token store, same pattern as everything else in this project.

You create your own Google Cloud project and OAuth client — see the generated project's own
`GOOGLE_SETUP.md` for the exact click-by-click steps.

See the [main repo](https://github.com/csr1010/whatsapp-ai-agent-sdk) for the full picture.

## License

MIT.
