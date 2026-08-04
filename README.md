# @pipeworx/gleif

Global Legal Entity Identifier Foundation MCP — LEI lookup and corporate hierarchy, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `search_lei(query, country?, status?, page_size?)` — fuzzy entity-name search.
- `get_lei(lei)` — full Level 1 record.
- `get_lei_relationships(lei)` — Level 2 direct parent, ultimate parent, direct children.

## Data source

`https://api.gleif.org/api/v1/` — public JSON:API, no key required.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Gleif data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
