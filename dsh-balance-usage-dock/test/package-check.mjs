/**
 * Static validation of the installable package surface: manifest fields,
 * exported resources, locale display metadata and icon constraints.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const failures = [];
function check(label, condition, detail) {
	console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail === undefined || condition ? '' : ` — ${JSON.stringify(detail)}`}`);
	if (!condition) failures.push(label);
}

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('package.json'));

console.log('manifest');
check('has a scoped name', /^@[a-z0-9-]+\/[a-z0-9-]+$/.test(manifest.name), manifest.name);
check('declares the bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', manifest.dsh?.bundle);
check('declares a web client', manifest.dsh?.client?.platform === 'web', manifest.dsh?.client);
check('declares the manifest version', manifest.dsh?.manifestVersion === 1, manifest.dsh?.manifestVersion);
check('the patch file exists', fs.existsSync(path.join(root, 'cordis.patch.yml')));
check('the patch inserts this package', read('cordis.patch.yml').includes(`'${manifest.name}'`), read('cordis.patch.yml'));

console.log('exports');
for (const [key, target] of Object.entries(manifest.exports)) {
	const relative = typeof target === 'string' ? target : target.default;
	check(`${key} resolves`, relative.startsWith('./') && fs.existsSync(path.join(root, relative)), relative);
}
check('the client export is the graph bundle', manifest.exports['./client'] === './client.js');

console.log('client bundle');
const bundle = read('client.js');
const registered = /__ModuleLoader__[\s\S]{0,80}?id:\s*(["'])([^"']+)\1/.exec(bundle)?.[2];
check('registers the package name', registered === manifest.name, { registered, name: manifest.name });
check('loads exactly one factory', [...bundle.matchAll(/__ModuleLoader__\.load\(/g)].length === 1);
check('requests only the platform seed', !/require\((["'])(?!react\1)/.test(bundle), bundle.match(/require\((["'])[^)]*/g));
check('reads the host state route', bundle.includes('/dsh-balance-usage/state'));

console.log('host half');
const host = read('index.js');
check('exports apply', /export function apply\(/.test(host));
check('exports a name', /export const name = /.test(host));
check('exports inject', /export const inject = /.test(host));
check('claims the same route as the client', host.includes('/dsh-balance-usage'));

console.log('display metadata');
for (const language of ['en', 'zh']) {
	const file = `locale/${language}.json`;
	const dictionary = JSON.parse(read(file));
	check(`${file} carries meta.title`, typeof dictionary.meta?.title === 'string' && dictionary.meta.title !== '', dictionary);
	check(`${file} carries meta.description`, typeof dictionary.meta?.description === 'string', dictionary);
}
const icon = manifest.icon;
check('icon is a relative path', typeof icon === 'string' && !path.isAbsolute(icon) && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(icon), icon);
const iconBytes = fs.statSync(path.join(root, icon)).size;
check('icon is small enough', iconBytes <= 256 * 1024, iconBytes);
check('icon is an accepted type', ['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(icon).toLowerCase()), icon);

console.log('install files');
for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'README.md', 'README.zh.md']) {
	check(`files[] carries ${entry}`, manifest.files.includes(entry), manifest.files);
}

console.log(failures.length === 0 ? '\nPACKAGE OK' : `\n${failures.length} FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
