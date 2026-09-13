# BYD

Main project lives here. The standalone **BYD** updater utility for **Ubuntu 24.04 LTS** — a
separate, self-contained Electron app that pulls this repository from GitHub and relaunches
it — is in:

```
GitHub-Updater/
```

See [`GitHub-Updater/README.md`](GitHub-Updater/README.md) for build and setup details
(`npm install && npm run build` → `dist/BYD-1.0.0.AppImage` + `dist/byd-updater_1.0.0_amd64.deb`;
install with `sudo apt install ./byd-updater_1.0.0_amd64.deb` or run the AppImage after
`chmod +x` and `sudo apt install libfuse2t64`).
