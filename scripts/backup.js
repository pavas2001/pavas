'use strict';
// Create a backup now: `npm run backup`
const { backupNow, BACKUP_DIR } = require('../server/routes/system');
console.log(`Backup written: ${BACKUP_DIR}/${backupNow('manual')}`);
