---
name: add-local-mcp-server
description: Use when integrating a new MCP server located in a local directory into NanoClaw's containerized environment.
---

## When to Use
- User wants to "add an MCP server" they are developing or have locally.
- A new tool is required that is powered by an MCP server not yet integrated.
- The server is located outside the NanoClaw project root (e.g., in a sibling directory).

## Procedure

### 1. Configure Host-to-Container Mount
In `src/container-runner.ts`, add a read-only volume mount for the server directory.
- Use `os.homedir()` and `path.join()` to resolve host paths (e.g., `~/my-mcp-server`).
- Check if the directory exists using `fs.existsSync()` before pushing to the `mounts` array.
- Standard container path: `/workspace/<server-name>`.

```typescript
// Inside buildVolumeMounts
const serverDir = path.join(os.homedir(), 'my-mcp-server');
if (fs.existsSync(serverDir)) {
  mounts.push({
    hostPath: serverDir,
    containerPath: '/workspace/my-mcp-server',
    readonly: true,
  });
}
```

### 2. Register Server in Agent Runner
In `container/agent-runner/src/index.ts`, register the server in the `ClaudeCode` configuration.

- **Add to `allowedTools`**: Include the prefix `mcp__<server_key>__*`.
- **Add to `mcpServers`**: Use `sh -c` if you need to `cd` into the directory before running the start command (common for Python/Poetry or Node servers). Use `fs.existsSync` to make registration conditional on the mount being present.

```typescript
// Inside mcpServers configuration
...(fs.existsSync('/workspace/my-mcp-server')
  ? {
      my_server: { // tool prefix will be mcp__my_server__
        command: 'sh',
        args: [
          '-c',
          'cd /workspace/my-mcp-server && poetry run python src/main.py',
        ],
      },
    }
  : {}),
```

### 3. (Optional) Forward Secrets
If the server requires API keys or tokens:
1. Add the variable to `src/config.ts` (reading from `process.env` or `envConfig`).
2. Update `src/container-runner.ts` to pass the variable into the container environment via the `spawn` call (usually handled in the `ContainerInput` or by injecting into the `exec` environment).

## Pitfalls and Fixes
- **Prefix Mismatch**: The key used in `mcpServers` (e.g., `my_server`) determines the tool prefix (`mcp__my_server__`). Ensure this matches what is added to `allowedTools`.
- **Read-Only Mount vs. Installation**: If the server is mounted read-only, it cannot run `npm install` or `poetry install` at runtime. Ensure dependencies are either pre-installed on the host (and accessible to the container) or baked into the container image.
- **Path Resolution**: Always use `path.join(os.homedir(), ...)` instead of `~/` when working in Node.js source code.

## Verification
1. Run `npm run build` to compile host changes.
2. Restart NanoClaw.
3. Use `claw` or a chat channel to ask the agent: "List your available tools" or "Call mcp__<server_key>__<tool_name>".
4. Check logs for spawn errors or "command not found".
