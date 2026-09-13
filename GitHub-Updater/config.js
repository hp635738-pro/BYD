'use strict';

// Application defaults for the Ubuntu build.
//
// The repository location is deliberately NOT stored here: it is selected by
// the user and persisted by Electron in its per-user data folder
// (app.getPath('userData') -> ~/.config/BYD/settings.json on Ubuntu 24.04).
module.exports = {
  remote: 'origin',
  branch: 'main',
  expectedRepository: 'https://github.com/hp635738-pro/BYD.git',
  timeoutMs: 120000,
  // git binary, resolved from PATH (Ubuntu: `sudo apt install git` -> /usr/bin/git).
  // Set an absolute path here only if git lives outside PATH.
  gitPath: 'git',
  projectLaunch: null
};
