// Sets the same version in manifest.json and package.json.
// Usage: npm run version:set -- 1.2.0
const fs = require('fs');
const path = require('path');
const version = process.argv[2];
if (!/^\d+(\.\d+){0,3}$/.test(version || '')) {
  console.error('Usage: npm run version:set -- <major.minor.patch>');
  process.exit(1);
}
for (const file of ['manifest.json', 'package.json']) {
  const p = path.join(__dirname, '..', file);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  json.version = version;
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
}
console.log(`Version set to ${version}. Next: git commit -am "Release v${version}" && git tag v${version} && git push --follow-tags`);
