# Mount seats-aero skill in Agent Container

## Objective
Mount the `seats-aero` flight-search skill directory from the host (`/home/whenke/seats-aero-mcp/skills/flight-search`) into the agent's `.claude/skills/` directory (`/home/node/.claude/skills/flight-search`) inside the container. This will allow the agent to use the skill since the execution loop is already configured to permit the `Skill` tool and load from filesystem sources.

## Implementation Steps

1.  **Modify `src/container-runner.ts`:**
    *   Locate the `buildVolumeMounts` function.
    *   Find where the main `.claude` directory is mounted (`mounts.push({ hostPath: groupSessionsDir, containerPath: '/home/node/.claude', readonly: false });`).
    *   Add a check for the existence of the host skill directory (`/home/whenke/seats-aero-mcp/skills/flight-search`).
    *   If the directory exists, push a new `VolumeMount` object to the `mounts` array, mounting the host directory to `/home/node/.claude/skills/flight-search` as read-only.

## Verification
1.  Verify the TypeScript build succeeds (`npm run build`).
2.  Restart the container agent and run a test prompt to ensure it can discover and load the `flight-search` skill.