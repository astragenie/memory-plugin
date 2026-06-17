---
description: Store the supplied text as a memory in AstraMemory with sensible defaults inferred from the current repo and context.
---

# /remember

Persist the supplied text into AstraMemory so future sessions can recall it.

User input: $ARGUMENTS

Workflow:

1. Decide the right metadata:
   - **type**: pick from `fact`, `preference`, `decision`, `event`, `task_result`, `lesson`, `summary`, `note`. Default to `note` if unclear. Use `decision` if the text reads like an ADR / "we chose X over Y" / "going with...".
   - **scope**: default `private` unless the user says otherwise. Use `project` if the text is project-specific or user said "for the whole project".
   - **project_id**: infer from the current repo name (`basename "$PWD"`). User can override with leading `[project:<name>]` token.
   - **tags**: extract obvious topical tags from the body (e.g. handoffs, costs, perf, ux). Lowercase, slugified.
   - **importance**: 0.7 by default. 0.9 if user said "important" / "critical". 0.4 if it reads like an offhand observation.
2. Strip any leading `[project:...]`, `[tag:...]`, `[type:...]` tokens after parsing — they're config, not body content.
3. Call the AstraMemory MCP `store_memory` tool with the assembled fields.
4. Report back the new memory id, the inferred metadata, and a one-line confirmation. If dedup hit, say so and show the existing id.

If MCP server is unreachable: tell the user the AstraMemory stack is down.
