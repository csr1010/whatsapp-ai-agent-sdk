# @wappy_ai/connector-cognee

Bring-your-own [Cognee](https://www.cognee.ai/) instance (self-hosted or cloud) as the
Knowledge/RAG backend for [`@wappy_ai/harness`](https://www.npmjs.com/package/@wappy_ai/harness),
part of [Wappy](https://github.com/csr1010/whatsapp-ai-agent-sdk). Instead of local keyword/BM25 matching,
Cognee builds a knowledge graph of entities and relationships as you ingest data, and keeps
refining it over repeated ingests.

Included automatically when you pick Cognee over the local memory backend in
[`npm create @wappy_ai/agent`](https://www.npmjs.com/package/@wappy_ai/create-agent) — most people
won't install it directly.

```bash
npm install @wappy_ai/connector-cognee
```

## What's in here

- **`createCogneeClient`** — a hand-rolled REST client against Cognee's real API (no official
  Node.js/TypeScript SDK exists; Cognee's primary SDK is Python).
- **`createCogneeKnowledge`** — a real implementation of `@wappy_ai/harness`'s `Knowledge`
  interface (`ingest`/`recall`/`remove`), backed by Cognee instead of local BM25. A second `ingest`
  under the same source id replaces the prior content, it doesn't accrete alongside it.

You need your own running Cognee instance — self-hosted (Docker or `pip install cognee`, no Docker
required) or Cognee Cloud. See the generated project's own `COGNEE_SETUP.md` for real, tested
setup steps for all three paths, including how to get an API key.

See the [main repo](https://github.com/csr1010/whatsapp-ai-agent-sdk) for the full picture.

## License

MIT.
