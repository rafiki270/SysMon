'use strict';
// Electron end-to-end flows. Serial: each spec launches its own app instance.
module.exports = {
  testDir: 'flows',
  timeout: 90000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
};
