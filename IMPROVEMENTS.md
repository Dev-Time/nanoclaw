# NanoClaw Improvements

A list of ideas and features to implement to enhance the NanoClaw personal assistant.

## Memory & Context
- **Unified Memory Manager**: Implement a dedicated background process or tool to proactively manage memory layers. This would automatically summarize archived conversations from `conversations/` into `CLAUDE.md`, prune outdated facts, and ensure that both global and group-specific memory remain concise and organized.

## Thinking & Reasoning (Claude 3.7+)
- **Explicit Thinking Mode Configuration**: Add support for `max_thinking_tokens` and `thinking_effort` (low, medium, high) in `models.yaml` and `.env`. Currently, thinking mode is disabled by default because the `query()` options in `agent-runner` lack these explicit parameters.
- **Thinking Effort Support**: Allow users to tune the "effort" or computation spent on reasoning for supported models, balancing response speed with reasoning depth.
- **Ollama Reasoning Control**: Ensure that local reasoning models (like DeepSeek-R1) are treated as first-class citizens by mapping the "thinking" and "effort" abstractions to Ollama-specific sampling settings and ensuring consistent UI formatting for their `<think>` tags.

## New Commands
- **Implement `/insights` Passthrough Command**: Add a new session command `/insights` that intercepts the message at the orchestrator level and passes it directly to the agent container as a prompt. This would allow the agent to analyze the current session and provide high-level insights or summaries on demand, similar to the `/compact` command.
- **Implement `/status` Status Command**: Add a new session command `/status` that lists all currently running containers and provides real-time information on whether any messages are being processed. This would improve visibility into the orchestrator's state.
- **Implement `/context` Context Command**: Add a new session command `/context` to view the current state of the session's context, including token counts, loaded memory files (CLAUDE.md), and compaction status.
