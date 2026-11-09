// Use the same pinned checksums as Electron's own installer. Fetching the archive
// must not also depend on a second, uncached GitHub checksum-file request.
module.exports = {
  extends: './electron-builder.yml',
  electronVersion: require('electron/package.json').version,
  electronDownload: {
    // Select electron-builder's @electron/get options branch; its legacy branch
    // otherwise discards `checksums` even though the configuration accepts them.
    force: false,
    checksums: require('electron/checksums.json'),
  },
};
