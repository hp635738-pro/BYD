'use strict';

// Application defaults. The repository location is deliberately not stored here:
// it is selected by the user and persisted in Electron's per-user data folder.
module.exports = {
  remote: 'origin',
  branch: 'main',
  expectedRepository: 'https://github.com/hp635738-pro/BYD.git',
  timeoutMs: 120000,
  projectLaunch: null
};
