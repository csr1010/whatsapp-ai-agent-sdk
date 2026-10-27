# @wappy_ai/core

The shared contracts that the rest of [Wappy](https://github.com/csr1010/whatsapp-ai-agent-sdk) is built on:
`Tool`, `Memory`, `MessageChannel`, `SmartMessage`, `Clock`, and the other interfaces every other
`@wappy_ai/*` package implements or consumes. Zero dependency on any specific model provider,
channel, or storage backend — those live in the packages that implement these interfaces.

Most people won't install this directly — it comes in automatically via
[`npm create @wappy_ai/agent`](https://www.npmjs.com/package/@wappy_ai/create-agent). It's useful
on its own if you're implementing a new connector or storage backend against these same contracts.

```bash
npm install @wappy_ai/core
```

See the [main repo](https://github.com/csr1010/whatsapp-ai-agent-sdk) for the full picture of how this fits
together.

## License

MIT.
