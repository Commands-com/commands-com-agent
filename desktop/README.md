# Commands.com Desktop (Electron)

Local-first setup and control companion for Commands agents.

This desktop app provides:
- local agent setup wizard (multi-profile, 5-step flow)
- MCP module selection with deploy/config options
- scheduler configuration per profile
- run-and-validate step before final review
- export of setup JSON for gateway/agent integration
- one-click bootstrap command copy for first run
- direct Start/Stop controls for local `./start-agent.sh` with live logs

## Run

```bash
cd /Users/dtannen/Code/commands-com-agent/desktop
npm install
npm run dev
```

## Notes

- Wizard state is stored in local browser storage inside the app.
- JSON export is saved through native OS save dialog.
- This is a scaffold for demo and v1 implementation tasks.
