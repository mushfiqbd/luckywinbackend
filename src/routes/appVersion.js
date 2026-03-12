const express = require('express');
const router = express.Router();

/**
 * GET /api/app-version
 * Returns latest app version for auto-update check.
 * Set APP_VERSION, APP_VERSION_CODE, APP_DOWNLOAD_URL in .env
 */
router.get('/', (req, res) => {
  const version = process.env.APP_VERSION || '1.0.1';
  const versionCode = parseInt(process.env.APP_VERSION_CODE || '2', 10);
  const downloadUrl = process.env.APP_DOWNLOAD_URL || '';
  const forceUpdate = process.env.APP_FORCE_UPDATE === 'true';

  return res.json({
    version,
    versionCode,
    downloadUrl,
    forceUpdate,
  });
});

module.exports = router;
