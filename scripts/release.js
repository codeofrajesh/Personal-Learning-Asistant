import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const type = process.argv[2] || 'patch'; // 'patch', 'minor', or 'major'

console.log(`🚀 Starting release process (${type} update)...`);

// 1. Get current version from package.json
const pkgPath = path.resolve('package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;

let [major, minor, patch] = oldVersion.split('.').map(Number);
if (type === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
} else if (type === 'minor') {
    minor += 1;
    patch = 0;
} else {
    patch += 1;
}

const newVersion = `${major}.${minor}.${patch}`;
console.log(`📦 Bumping version: ${oldVersion} -> ${newVersion}`);

// 2. Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 3. Update tauri.conf.json
const tauriConfPath = path.resolve('src-tauri/tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = newVersion;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');

// 4. Update Cargo.toml
const cargoTomlPath = path.resolve('src-tauri/Cargo.toml');
let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
cargoToml = cargoToml.replace(/version = ".*"/, `version = "${newVersion}"`);
fs.writeFileSync(cargoTomlPath, cargoToml);

console.log('✅ Updated all version files.');

try {
    console.log('🔄 Running cargo check to update Cargo.lock...');
    execSync('cargo check', { stdio: 'inherit', cwd: path.resolve('src-tauri') });

    console.log('🛠️ Committing changes to Git...');
    execSync('git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock', { stdio: 'inherit' });
    execSync(`git commit -m "chore: Release v${newVersion}"`, { stdio: 'inherit' });

    console.log('🏷️ Creating Git tag...');
    execSync(`git tag v${newVersion}`, { stdio: 'inherit' });

    console.log('☁️ Pushing to GitHub...');
    execSync('git push origin main', { stdio: 'inherit' });
    execSync(`git push origin v${newVersion}`, { stdio: 'inherit' });

    console.log(`\n🎉 Success! The OTA update for v${newVersion} is now compiling on GitHub Actions!`);
    console.log(`Users will automatically receive the update once the action completes.`);
} catch (error) {
    console.error('❌ Failed to run Git commands. Please finish manually.');
}
