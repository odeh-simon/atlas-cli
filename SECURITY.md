# Security Policy

Atlas runs coding agents, executes local processes and handles credentials for services such as Linear, GitHub, Figma and AI providers, so security reports are taken seriously.

## Supported versions

Atlas is pre-release. Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities privately through GitHub: go to the repository's **Security** tab and choose **Report a vulnerability**. Include:

- what the issue is and its potential impact
- steps to reproduce, or a proof of concept
- the Atlas version or commit, OS and Node.js version

You should receive an acknowledgement within 7 days. Once the issue is confirmed, a fix will be prepared and released as soon as practical, and you will be credited in the release notes unless you prefer otherwise.

## Scope

Examples of issues in scope:

- secrets or tokens leaking into logs, artifacts, telemetry or writebacks
- bypassing an approval, review or completion gate
- command injection or unsafe process execution through the process runner or agent adapters
- reading or writing files outside the repository or Atlas's own storage
- sandbox or Git safeguard bypasses

## Handling credentials

Atlas stores credentials as aliases and redacts known secret formats, but always review command output before sharing it publicly.
