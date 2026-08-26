# @pipeworx/gleif

Global Legal Entity Identifier Foundation MCP — LEI lookup, ISIN/BIC-to-entity mapping, and corporate hierarchy, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

- `search_lei(query, country?, status?, page_size?)` — fuzzy entity-name search. If `country` narrows the result to nothing, the filter is dropped and the response says so via `country_filter_dropped` — GLEIF filters on the *registered legal address*, which often is not where the entity operates (no Sberbank-named record has a Russian one; they sit in CY/SK/LU/GB).
- `get_lei(lei)` — full Level 1 record: legal name, addresses, jurisdiction, legal form, and LEI registration status. Accepts a company **name** as well as a 20-character LEI; a resolved name is echoed back as `resolved_from_name`.
- `get_lei_relationships(lei)` — Level 2 direct parent, ultimate parent, direct children (one hop).
- `isin_to_lei(isin)` — resolve a security's ISIN to the legal entity that issued it (LEI + legal name). A valid-but-unmapped ISIN is reported as `mapped: false, reason: "isin_unmapped"` — the mapping lags new issuance, so unmapped ≠ nonexistent.
- `lei_to_isins(lei)` — all ISINs issued by an entity (LEI or company name accepted). Returns the full set — one entity issues many securities.
- `bic_to_lei(bic)` — resolve a SWIFT/BIC (8 or 11 chars) to the bank's legal entity. 8-char codes are padded to the `XXX` head-office form (GLEIF's filter matches 11-char BICs only); a branch BIC with no mapping of its own falls back to the head office and says so.
- `lei_hierarchy_tree(lei, depth?)` — multi-hop ownership: ancestor chain up to the ultimate parent plus a breadth-first subsidiary tree (depth 1–4, default 2, node budget 150/call).

## Data source

`https://api.gleif.org/api/v1/` — public JSON:API, no key required. ISIN and BIC joins use GLEIF's official ISIN-to-LEI and BIC-to-LEI mapping files as served through the same API (`filter[isin]`, `filter[bic]`, `/lei-records/{lei}/isins`).

## Passing an LEI

Every tool that takes an `lei` argument also takes a company **name** — the name is resolved
against the registry and the match is returned alongside the answer. Pass the name whenever
that is what you have.

**Never construct an LEI code.** A guessed 20-character string that happens to be a real LEI
belongs to some other company, and GLEIF returns its record with nothing to indicate the wrong
entity was fetched — a request for Wirecard AG once came back as Baader Bank
Aktiengesellschaft. Codes are checked against the ISO 17442 (ISO 7064 MOD 97-10) check digits
before any request is made, and a code that fails is rejected with a message naming
`search_lei`; that catches roughly 96 of every 97 invented codes, but not one that collides
with a live record, which is why the name path exists.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "gleif": {
      "url": "https://gateway.pipeworx.io/gleif/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/gleif/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Gleif data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
