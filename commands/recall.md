---
description: Search the AstraMemory memory service for memories matching a query and inject them into context.
---

# /recall

Search AstraMemory for memories matching the user's query and inject the top results into the conversation so the rest of the session can use them as grounding context.

User query: $ARGUMENTS

Workflow:

1. Use the AstraMemory MCP `search_memory` tool with:
   - `query` = the user's query above
   - `top_k` = 8
   - `mode` = "hybrid"
   - If the user named a project (e.g. "in loop", "for crew"), pass it as `project_id` filter
   - If they named a tag (e.g. "handoffs", "cost-reports"), pass it as `tags`
2. Format the results compactly: one line per hit with type, project, first 120 chars of content, and rank score.
3. End with a short synthesis: what these memories collectively say about the query.

If no memories match: say so plainly and suggest `/remember` to store something now.

If MCP server is unreachable: hint that the AstraMemory stack is down — point at `dotnet run --project src/MemoryService.AppHost`.
