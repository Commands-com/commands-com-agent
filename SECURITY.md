# Security Policy

## Supported versions

Security fixes are provided for the latest main branch and the most recent release.

## Reporting a vulnerability

Please do not open public GitHub issues for security vulnerabilities.

Email: **security@commands.com**

Include:

- Description of the issue and potential impact
- Steps to reproduce / proof of concept
- Affected components and versions
- Any suggested mitigation

We will acknowledge receipt as quickly as possible and coordinate remediation and disclosure timing.

## Scope notes

For this project, high-priority reports typically include:

- Auth bypass or token leakage
- E2E crypto misuse or key exposure
- IPC trust boundary bypass
- Remote code execution or XSS in desktop/web surfaces
- Privilege escalation in gateway relay/session handling
