'use strict';

/**
 * ============================================================================
 *  GitHub Updater — configuration
 * ============================================================================
 *
 *  This is the ONLY file in the whole project that contains filesystem paths.
 *  main.js, preload.js and renderer.js all read the repository location from
 *  here — nothing is hardcoded anywhere else.
 *
 *  To point the updater at a different project, edit `repoPath` below and
 *  rebuild (`npm run build`).
 *
 *  NOTE FOR PACKAGED BUILDS
 *  ------------------------
 *  Once the app is compiled into an .exe this file lives inside app.asar, so
 *  change it *before* building. To keep the path editable after installation,
 *  build with `npm run build:dir` and edit config.js next to the resources
 *  folder, or use `app.asar.unpacked` in the electron-builder config.
 * ============================================================================
 */

module.exports = {
  /**
   * Absolute path to the local Git repository that this updater manages.
   * Windows paths must use double backslashes ("C:\\HPOS") or forward
   * slashes ("C:/HPOS") — both work.
   *
   * @type {string}
   */
  repoPath: 'C:\\HPOS',

  /**
   * Git remote and branch used by the "Pull from GitHub" button.
   * Together they form the command:  git pull <remote> <branch>
   */
  remote: 'origin',
  branch: 'main',

  /**
   * Safety net: abort the pull if it has not finished after this many
   * milliseconds (default 2 minutes). Set to 0 to disable the timeout.
   */
  timeoutMs: 120000,

  /**
   * Optional — leave as `null` for the default behaviour.
   *
   * The "Update" button relaunches THIS updater (app.relaunch + app.quit),
   * which is enough when the updater itself is the app being updated.
   *
   * If instead the updater is a standalone .exe that updates a *separate*
   * project, set this to the command that starts that project. It is launched
   * right before the updater restarts, so the freshly pulled code loads:
   *
   *   projectLaunch: { command: 'C:\\HPOS\\HPOS.exe', args: [] }
   *   projectLaunch: { command: 'cmd.exe', args: ['/c', 'start', 'npm', 'start'] }
   *
   * @type {{command: string, args?: string[], cwd?: string}|null}
   */
  projectLaunch: null
};
