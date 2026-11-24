'use strict';
// Entry point for the Windows service (registered by the installer with NSSM). Loads the config
// file the installer wrote, then starts Pixberry exactly as `node server/index.js` would.
require('./windows-config');
require('../server/index.js').start();
