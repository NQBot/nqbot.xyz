# Public configuration policy

This GitHub Pages repository intentionally contains no executable MCP, agent,
automation, or production-service configuration. Those files can expose local
endpoints and encourage tools to receive credentials from a public working
tree.

Keep operational configuration outside this repository. In particular:

- store credentials in an operating-system secret store or a CI secret store;
- grant each token only the permissions required for its single task;
- bind local control services to loopback unless remote access is explicitly
  designed, authenticated, and reviewed;
- pin audited tool and package versions instead of auto-installing `latest`;
- never commit bearer tokens, API keys, passwords, private keys, webhook
  secrets, session cookies, or credential-bearing URLs.

The site security validator rejects known operational-config paths and common
secret formats before publication.
