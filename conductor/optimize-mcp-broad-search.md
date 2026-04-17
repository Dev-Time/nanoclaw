---
name: optimize-mcp-broad-search
description: Use when handling MCP tools that return large JSON results or require complex client-side filtering to avoid token limits and rate limit issues.
---

## When to Use
- An MCP tool returns a large amount of data that would exceed token limits if dumped entirely into the context.
- The server-side filtering is insufficient or slow.
- The tool (like Seats.Aero) specifically recommends a "search broad, filter local" pattern.

## Procedure

### 1. Execute Broad Search
Call the tool with the minimum required filters to get all relevant results.
- Set `max_items: 0` (or the equivalent for "all results").
- Omit specific cabin or carrier filters if they are more efficiently handled locally.
- For date ranges, prefer single-day searches if rate limits are a concern.

### 2. Persist to Temporary File
Save the raw JSON output to a temporary file in the workspace (e.g., `results.json`). This keeps the large payload out of the immediate conversation context.

### 3. Apply Local Filtering with `jq`
Use `jq` to filter and sort the results. 
- **Numeric Safety**: Use `*Raw` fields (e.g., `JMileageCostRaw`) for numeric comparisons to ensure `jq` treats them as numbers, not strings.
- **Fallbacks**: Implement priority-based fallbacks (e.g., Business > Premium > Economy) within the `jq` script.
- **Array Handling**: If the tool returns a JSON array, ensure the `jq` command correctly handles it (avoid unnecessary `-s` flags).

```bash
cat results.json | jq 'map(select(.JMileageCostRaw < 100000)) | sort_by(.JMileageCostRaw) | .[0]'
```

### 4. Format and Present
Extract only the top 1-3 best matches and format them into a human-readable markdown block. If no results match, inform the user and suggest relaxing specific constraints.

### 5. Cleanup
Delete temporary result files older than 24 hours to prevent workspace clutter.

## Pitfalls and Fixes
- **Stale Data**: Ensure the pre-search cleanup step is followed to avoid using results from previous days.
- **Empty Results**: Check for zero-cost results or empty arrays before presenting to the user.

## Verification
- Verify that the `jq` command produces the expected JSON object before formatting.
- Confirm that the number of tokens used is significantly lower than a direct tool call dump.
