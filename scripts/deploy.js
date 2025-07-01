const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync('.');
const vsixFiles = files.filter(f => f.endsWith('.vsix'));

if (vsixFiles.length === 0) {
  console.error('No .vsix files found!');
  process.exit(1);
}

const latestVsix = vsixFiles
  .map(f => ({ file: f, mtime: fs.statSync(f).mtime }))
  .sort((a, b) => b.mtime - a.mtime)[0].file;

console.log(`Installing ${latestVsix}...`);

try {
  execSync(`code --install-extension ${latestVsix}`, { stdio: 'inherit' });
  console.log('VSIX installed. Please reload VS Code (F1 > Reload Window)');
} catch (error) {
  console.error('Failed to install VSIX:', error);
  process.exit(1);
}