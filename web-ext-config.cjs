// Shared settings for `web-ext lint | build | sign | run`.
module.exports = {
  ignoreFiles: [
    '.github',
    'scripts',
    'test',
    'package.json',
    'package-lock.json',
    'amo-metadata.json',
    'web-ext-config.cjs',
    'web-ext-artifacts'
  ],
  build: {
    overwriteDest: true
  }
};
