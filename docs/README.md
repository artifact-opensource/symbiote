<div align="center">

# Symbiote Documentation

**Persistent AI agent runtime · v4.0.0**

[Quick Start](getting-started/quick-start.md) · [Configuration](getting-started/configuration.md) · [CLI](reference/cli.md) · [Tools](tools/built-in.md)

</div>

---

## Guides

- [Quick Start](getting-started/quick-start.md)
- [Configuration](getting-started/configuration.md)
- [Boot Sequence](core/boot-sequence.md)
- [COMB and VDB Memory](core/comb.md)
- [Memograph Integration](core/memograph.md)
- [Built-in Tools](tools/built-in.md)
- [Provider Overview](providers/overview.md)
- [CLI Reference](reference/cli.md)
- [Environment Variables](reference/environment.md)
- [Documentation Map](SUMMARY.md)

## Runtime Notes

Symbiote includes an embedded workspace VDB using BM25 and sparse TF-IDF retrieval. Memograph snapshots can be imported as separate LIVE, PROJECT, and ENTERPRISE memory records; shard permissions and topology metadata are retained for context assembly. Dense embedding generation is not included by default.

Provider and channel availability depends on configuration and credentials. Tool counts vary by runtime; use the CLI `/tools` command or MCP `tools/list` for the active set.

## License

Symbiote is MIT licensed. See the repository [LICENSE](../LICENSE).
