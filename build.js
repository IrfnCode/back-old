import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_DIR = __dirname;
const TARGET_DIR = path.join(__dirname, '../BACKENC-OLD');

console.log('🚀 Starting build process for BACKENC-OLD...');

// 1. Prepare Target Directory
if (fs.existsSync(TARGET_DIR)) {
    console.log('🗑️ Cleaning existing Target Directory...');
    try {
        fs.rmSync(TARGET_DIR, { recursive: true, force: true });
    } catch(e) {
        console.warn('⚠️ Could not remove entirely, attempting to overwrite:', e.message);
    }
}
fs.mkdirSync(TARGET_DIR, { recursive: true });
fs.mkdirSync(path.join(TARGET_DIR, 'config'), { recursive: true });
fs.mkdirSync(path.join(TARGET_DIR, 'data'), { recursive: true });

// 2. Write package.json (without devDependencies)
console.log('📦 Processing package.json...');
const pkg = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'package.json'), 'utf8'));
delete pkg.devDependencies;
if (pkg.scripts && pkg.scripts.build) delete pkg.scripts.build;
fs.writeFileSync(path.join(TARGET_DIR, 'package.json'), JSON.stringify(pkg, null, 2));

// 3. Generate Target .env
console.log('🌐 Generating .env...');
const envContent = `PORT=3333
NODE_ENV=production
BRIDGE_SECRET=WorkOrderPanAI
`;
fs.writeFileSync(path.join(TARGET_DIR, '.env'), envContent);

// 4. Copy config if it exists
const credsPath = path.join(SOURCE_DIR, 'config', 'credentials.json');
if (fs.existsSync(credsPath)) {
    fs.copyFileSync(credsPath, path.join(TARGET_DIR, 'config', 'credentials.json'));
    console.log('🔐 Copied credentials.json');
} else {
    fs.writeFileSync(path.join(TARGET_DIR, 'config', 'credentials.json'), JSON.stringify({username: '', password: '', totpSecret: '', loginUrl: ''}, null, 2));
    console.log('⚠️ Created empty credentials.json');
}

// 5. Obfuscate source code via javascript-obfuscator CLI
console.log('🔒 Obfuscating src code... This may take a moment.');
try {
    const obfCmd = `npx javascript-obfuscator ./src --output ../BACKENC-OLD/src --target node`;
    execSync(obfCmd, { cwd: SOURCE_DIR, stdio: 'inherit' });
    console.log('✅ Obfuscation complete.');
    
    // 6. Exclude auth.js from obfuscation by overwriting it with original source
    console.log('🔄 Overwriting auth.js with original un-obfuscated version...');
    const originalAuthPath = path.join(SOURCE_DIR, 'src', 'services', 'auth.js');
    const targetAuthPath = path.join(TARGET_DIR, 'src', 'services', 'auth.js');
    fs.copyFileSync(originalAuthPath, targetAuthPath);
    console.log('✅ auth.js successfully exempted from obfuscation.');
} catch (e) {
    console.error('❌ Failed to obfuscate source code:', e.message);
    process.exit(1);
}

console.log('🎉 Build successfully generated at BACKENC-OLD! 🎉');
