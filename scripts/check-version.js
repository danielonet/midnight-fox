// Fails if the git tag (e.g. v1.2.3) doesn't match manifest.json and package.json.
// Usage: node scripts/check-version.js v1.2.3
const path = require('path');
const root = path.join(__dirname, '..');
const manifest = require(path.join(root, 'manifest.json')).version;
const pkg = require(path.join(root, 'package.json')).version;
const tag = (process.argv[2] || '').replace(/^refs\/tags\//, '').replace(/^v/, '');

const problems = [];
if (manifest !== pkg) problems.push(`manifest.json (${manifest}) and package.json (${pkg}) differ`);
if (tag && tag !== manifest) problems.push(`tag v${tag} does not match manifest.json version ${manifest}`);
if (!/^\d+(\.\d+){0,3}$/.test(manifest)) problems.push(`"${manifest}" is not a valid Firefox version`);

if (problems.length) {
  console.error('Version check failed:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`Version OK: ${manifest}`);
