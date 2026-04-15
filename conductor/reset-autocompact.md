# Objective
Reset the conversation autocompact threshold from 160,000 to 100,000 tokens to ensure sessions are compacted earlier.

# Key Files & Context
- `src/container-runner.ts`: Configures the environment variables passed to the agent container.
- `container/agent-runner/src/index.ts`: Default value inside the agent runner.

# Implementation Steps
1. **Modify `src/container-runner.ts`**:
   - Update the comment at line 186: `// Trigger compaction when context reaches 160,000 tokens` -> `// Trigger compaction when context reaches 100,000 tokens`
   - Update line 187: `CLAUDE_CODE_AUTO_COMPACT_WINDOW: '160000',` -> `CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000',`
2. **Modify `container/agent-runner/src/index.ts`**:
   - Update line 968: `CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.COMPACT_WINDOW || '160000',` -> `CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.COMPACT_WINDOW || '100000',`

# Verification & Testing
- Search for "160000" and "160,000" project-wide to ensure no other hardcoded references remain.
- Build the project (`npm run build`).
- Verify the change in the running container (can be checked by inspecting the environment variables of a spawned container or by manual verification of the build output).
