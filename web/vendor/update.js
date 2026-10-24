// Copies the two browser libraries the family app uses into web/vendor, as ES
// modules the page can import with no build step: `npm run vendor` after
// changing a version in web/package.json. The output is committed.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendorDir = dirname(fileURLToPath(import.meta.url));
const modules = join(vendorDir, '..', 'node_modules');

function version(pkg) {
  return JSON.parse(readFileSync(join(modules, pkg, 'package.json'), 'utf8')).version;
}

// tus-js-client ships its browser build as a browserify UMD bundle (its lib.esm
// tree still imports bare npm names). Run the UMD inside a module scope that
// offers it `module.exports`, then re-export what it returns.
function vendorTus() {
  const out = join(vendorDir, 'tus-js-client');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const umd = readFileSync(join(modules, 'tus-js-client', 'dist', 'tus.min.js'), 'utf8')
    .replace(/\n\/\/# sourceMappingURL=.*$/m, '');
  const v = version('tus-js-client');
  const esm = `// tus-js-client ${v} (MIT), browser build wrapped as an ES module by web/vendor/update.js.
const module = { exports: {} };
const exports = module.exports;
${umd}
const tus = module.exports;
export default tus;
export const { Upload, isSupported, canStoreURLs, defaultOptions, enableDebugLog, DetailedError } = tus;
`;
  writeFileSync(join(out, 'tus.js'), esm);
  cpSync(join(modules, 'tus-js-client', 'LICENSE'), join(out, 'LICENSE'));
  return v;
}

function copyJsTree(from, to) {
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (statSync(src).isDirectory()) copyJsTree(src, join(to, name));
    else if (name.endsWith('.js')) {
      mkdirSync(to, { recursive: true });
      cpSync(src, join(to, name));
    }
  }
}

// @simplewebauthn/browser's esm tree has no dependencies and uses relative
// imports with extensions, so the .js files are copied as they are.
function vendorWebAuthn() {
  const pkg = join(modules, '@simplewebauthn', 'browser');
  const out = join(vendorDir, 'simplewebauthn-browser');
  rmSync(out, { recursive: true, force: true });
  copyJsTree(join(pkg, 'esm'), out);
  cpSync(join(pkg, 'LICENSE.md'), join(out, 'LICENSE.md'));
  return version('@simplewebauthn/browser');
}

const versions = { 'tus-js-client': vendorTus(), '@simplewebauthn/browser': vendorWebAuthn() };
writeFileSync(join(vendorDir, 'VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
console.log(`vendored into ${relative(process.cwd(), vendorDir) || '.'}:`, versions);
