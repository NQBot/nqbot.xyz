# MCP Server Configuration for Claude Code

This directory contains MCP (Model Context Protocol) server configurations used with Claude Code CLI for the NQBotLive streaming automation.

## Available MCP Servers

| Server | Purpose | Package |
|--------|---------|--------|
| **github** | GitHub repo management, commits, PRs | `@modelcontextprotocol/server-github` |
| **obs** | Full OBS Studio control | `obs-mcp` |
| **obs-lite** | Lightweight OBS control (custom) | Custom Python script |
| **youtube** | YouTube Data API access | `youtube-data-mcp-server` |
| **youtube-live** | YouTube Live streaming control | Custom Node.js server |
| **n8n** | Workflow automation | `n8n-mcp` |

## Setup Instructions

### 1. Install Claude Code CLI
```bash
npm install -g @anthropic-ai/claude-code
```

### 2. Configure MCP Servers

Add the MCP server configurations to your Claude config file:
- **Windows:** `C:\Users\<username>\.claude.json`
- **Mac/Linux:** `~/.claude.json`

Use `mcp-servers-template.json` as a starting point. Add the `mcpServers` section to your project configuration within the `projects` object.

### 3. Required API Keys

**GitHub:**
- Create a Personal Access Token at https://github.com/settings/tokens
- Required scopes: `repo`, `read:org`

**YouTube:**
- Create project at https://console.cloud.google.com
- Enable YouTube Data API v3
- Create API key

**OBS:**
- Enable WebSocket server in OBS: Tools → WebSocket Server Settings
- Set a password and use it in the config

**n8n:**
- Self-host n8n or use n8n.cloud
- Generate API key from Settings → API

### 4. Custom Servers

**obs-lite** - Lightweight Python OBS controller:
- Requires `obs-websocket-py` package
- See `tools/obs_mcp/obs_mcp_server.py` in main repo

**youtube-live** - YouTube Live streaming control:
- Requires OAuth setup with YouTube Live Streaming API
- Custom Node.js server for broadcast management

## Usage in Claude Code

Once configured, servers appear in the MCP menu (`/mcp` command). Enable/disable servers as needed for your session.

## Troubleshooting

- **Server won't connect:** Check that required packages are installed (`npx` auto-installs)
- **Permission denied:** Verify API keys have correct scopes
- **OBS not responding:** Ensure OBS is running with WebSocket server enabled

## License

MIT - Use freely for your own streaming automation projects.
