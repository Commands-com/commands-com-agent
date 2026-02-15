# Contributing

Thanks for your interest in contributing to `commands-com-agent`.

## How to contribute

1. Fork the repository and create a feature branch.
2. Keep changes focused and small.
3. Add or update tests where practical.
4. Run local checks before opening a PR.
5. Open a pull request with a clear summary and rationale.

## Development setup

1. Use Node.js 20+.
2. Install dependencies:

```bash
npm install
```

3. Build the agent:

```bash
npm run build
```

4. Type-check:

```bash
npm run typecheck
```

5. (Optional) Run desktop app:

```bash
npm run dev:desktop
```

## Pull request guidelines

- Describe the problem and the approach.
- Include security considerations for auth, crypto, IPC, and network changes.
- Avoid unrelated refactors in the same PR.
- Update docs if behavior or contracts change.

## Code style

- Prefer clear, explicit code and small functions.
- Keep renderer/main process boundaries strict.
- Never expose tokens, keys, or ciphertext to renderer APIs.

## Reporting bugs

Please include:

- Expected behavior vs actual behavior
- Steps to reproduce
- Environment details (OS, Node version)
- Relevant logs (redacted)
