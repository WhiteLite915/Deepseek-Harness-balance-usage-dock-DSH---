/**
 * One-shot installer for the Balance & Usage Dock plugin.
 *
 * It edits the DSH profile manifest and patch layer, then copies the package
 * into the profile's own `node_modules`, which is where the Loader resolves a
 * profile-installed bundle by name. Every step is conservative: existing
 * profile keys are preserved and the package copy is written through a
 * temporary directory first.
 *
 *   node scripts/install.mjs [--profile-dir <dir>] [--uninstall] [--lockfile]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const PACKAGE_NAME = '@deepseek-harness/dsh-balance-usage-dock';
const ROW_ID = 'balance-usage-dock';
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** Read one `--flag value` option. */
function option(name, fallback) {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? fallback : process.argv[at + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const profileDir = path.resolve(option('profile-dir', path.join(os.homedir(), '.dsh', 'profiles', 'desktop')));
const uninstall = flag('uninstall');

/**
 * Copy the published package surface next to the profile manifest, replacing
 * whatever an earlier installation left there. Test harness, installer and
 * docs stay in the source tree; the Loader only reads code and metadata.
 */
function copyPublished(from, to) {
	const staging = `${to}.staging-${process.pid}`;
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	for (const entry of ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'README.md', 'locale']) {
		const source = path.join(from, entry);
		if (!fs.existsSync(source)) throw new Error(`package file missing: ${source}`);
		fs.cpSync(source, path.join(staging, entry), { recursive: true });
	}
	fs.rmSync(to, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.renameSync(staging, to);
}

const manifestPath = path.join(profileDir, 'package.json');
const patchPath = path.join(profileDir, 'cordis.patch.yml');
const target = path.join(profileDir, 'node_modules', ...PACKAGE_NAME.split('/'));

if (!fs.existsSync(manifestPath)) {
	throw new Error(`no DSH profile at ${profileDir}; open DeepSeek Harness once, then retry`);
}
console.log(`package   ${PACKAGE_ROOT}`);
console.log(`profile   ${profileDir}`);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];

if (uninstall) {
	delete manifest.dependencies[PACKAGE_NAME];
	manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== PACKAGE_NAME);
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
	console.log('removed   dependency, bundle selection and installed files');
	console.log(`note      the patch row ${ROW_ID} stays in cordis.patch.yml; delete it to silence the skipped entry`);
	process.exit(0);
}

manifest.dependencies[PACKAGE_NAME] = `file:${PACKAGE_ROOT}`;
if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) manifest.dsh.profile.bundles.push(PACKAGE_NAME);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest  ${PACKAGE_NAME} -> file:${PACKAGE_ROOT}`);
console.log(`bundles   ${manifest.dsh.profile.bundles.join(', ')}`);

let patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
if (!patch.includes(`id: ${ROW_ID}`)) {
	if (patch !== '' && !patch.endsWith('\n')) patch += '\n';
	patch += [
		'',
		"# Balance & Usage Dock: live account balance, today's spend and a",
		'# ten-minute spend line left of the composer performance pills.',
		'- insert:',
		`    - id: ${ROW_ID}`,
		`      name: '${PACKAGE_NAME}'`,
		'',
	].join('\n');
	fs.writeFileSync(patchPath, patch);
	console.log(`patch     inserted row ${ROW_ID}`);
} else {
	console.log(`patch     row ${ROW_ID} already present`);
}

for (const entry of ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'locale']) {
	const from = path.join(PACKAGE_ROOT, entry);
	if (!fs.existsSync(from)) throw new Error(`package file missing: ${from}`);
}
copyPublished(PACKAGE_ROOT, target);
console.log(`installed ${target}`);

// The lockfile is optional: the copy above is what the Loader resolves, and a
// later `pnpm install` re-links the package from the manifest entry.
if (flag('lockfile')) {
	const nodeExe = process.execPath;
	const pnpmScript = option('pnpm', undefined);
	if (pnpmScript === undefined) throw new Error('--lockfile needs --pnpm <path to pnpm.mjs>');
	try {
		const output = execFileSync(nodeExe, [pnpmScript, 'install', '--lockfile-only', '--config.auto-install-peers=false'], {
			cwd: profileDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 240000,
		});
		console.log('pnpm      lockfile updated');
		if (output.trim() !== '') console.log(output.trim());
	} catch (error) {
		console.log('pnpm      lockfile update skipped; the installed copy still loads');
		if (error.stdout) console.log(String(error.stdout).trim());
		if (error.stderr) console.log(String(error.stderr).trim());
	}
}

console.log('');
console.log('Refresh the Harness window; the dock appears beside the performance pills.');
console.log('If it does not appear, fully quit and restart DeepSeek Harness.');
