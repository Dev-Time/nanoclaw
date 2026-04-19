# Fix Memory Extraction Chunking

## Objective
Fix the background memory extraction agent failing on large session logs by truncating massive strings (e.g., file reads or huge tool results) in the `chunk_reader.py` script before outputting the chunk.

## Key Files & Context
- `container/skills/playbook-architect/chunk_reader.py`: The script responsible for reading session `.jsonl` logs and grouping them into "turns" to provide context to the memory extraction agent.

## Implementation Steps
1. **Add Truncation Function**: Define a `truncate_large_strings(obj, max_len=2000)` recursive function in `chunk_reader.py`. It will traverse lists and dicts, and if it encounters a string exceeding `max_len`, it will slice it and append `... <truncated X more characters>`.
2. **Apply Truncation to Events**: Inside `get_jsonl_events()`, immediately after parsing an event using `json.loads(line)`, pass the event through `truncate_large_strings()` before appending it to the list.
3. **Keep Original Grouping Logic**: Leave the `group_into_turns` logic intact. Because all massive string properties (like file contents) will be reduced to 2,000 characters, individual turns will easily fit inside the 200,000 character budget without breaking JSON formatting or exceeding context limits.

## Verification & Testing
1. Execute `python3 container/skills/playbook-architect/chunk_reader.py get 200000 5` from the host on the `telegram_main` workspace and verify the output is a valid JSON string containing the recent turns without massive text blocks.
2. Confirm the length of the returned output is well within the 200,000 budget and the agent does not receive malformed data.
3. Trigger `/memo` and observe if it successfully processes multiple chunks and accurately extracts rules/memory from the truncated data.