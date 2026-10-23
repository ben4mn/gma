// Deployment and runtime guards: TRUST_PROXY and the client's address, the
// photo-drive sentinel (the app and the worker refuse to start without it),
// and the invariants of docker-compose.yml, the tunnel config, the Dockerfile
// and .env.example.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { ConfigError, loadConfig, parseTrustProxy } from '../src/config.js';
import { clientIp, compileTrust, normalizeAddress, rateLimitKey, resolveClientIp } from '../src/lib/client-ip.js';
import { BINARIES } from '../src/lib/media.js';
import { assertMediaMounted, createStorage, MediaNotMountedError } from '../src/lib/storage.js';
import { makeTempDir, makeTestApp, makeTestConfig } from './helpers/index.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SERVER = path.join(REPO, 'server');
const STRONG_SECRET = Buffer.alloc(48, 7).toString('base64');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('TRUST_PROXY', () => {
  test('true, false or a list of addresses and ranges', () => {
    assert.equal(parseTrustProxy('true', false), true);
    assert.equal(parseTrustProxy('off', true), false);
    assert.equal(parseTrustProxy('', true), true, 'empty means the default');
    assert.deepEqual(parseTrustProxy('10.35.0.3', false), ['10.35.0.3']);
    assert.deepEqual(parseTrustProxy(' 10.35.0.3 , 10.0.0.0/8,fd00::/8 ', false), ['10.35.0.3', '10.0.0.0/8', 'fd00::/8']);
    assert.ok(Object.isFrozen(parseTrustProxy('10.35.0.3', false)));
  });

  test('anything else fails with a readable message', () => {
    for (const bad of ['maybe', '10.35.0.3/33', '10.35.0.0/24/1', '300.1.1.1', 'fd00::/129', 'cloudflared']) {
      assert.throws(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: bad }), (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /TRUST_PROXY must be true, false or a comma-separated list/);
        return true;
      }, bad);
    }
  });

  test('on in production by default, off elsewhere', () => {
    assert.equal(loadConfig({ NODE_ENV: 'test' }).trustProxy, false);
    const prod = loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://gma.4mn.org', SECRET_KEY: STRONG_SECRET });
    assert.equal(prod.trustProxy, true);
  });
});

describe('MEDIA_SENTINEL', () => {
  const prodEnv = { NODE_ENV: 'production', PUBLIC_URL: 'https://gma.4mn.org', SECRET_KEY: STRONG_SECRET };

  test('.gma-media in production, nothing in development and tests', () => {
    assert.equal(loadConfig(prodEnv).mediaSentinel, '.gma-media');
    assert.equal(loadConfig({ NODE_ENV: 'test' }).mediaSentinel, '');
    assert.equal(loadConfig({ NODE_ENV: 'development' }).mediaSentinel, '');
    assert.equal(loadConfig({ NODE_ENV: 'test', MEDIA_SENTINEL: '.drive-ok' }).mediaSentinel, '.drive-ok');
    assert.equal(loadConfig({ ...prodEnv, MEDIA_SENTINEL: 'off' }).mediaSentinel, '');
  });

  test('must be a plain file name', () => {
    for (const bad of ['../etc/passwd', 'a/b', '..', 'with space']) {
      assert.throws(() => loadConfig({ NODE_ENV: 'test', MEDIA_SENTINEL: bad }), /MEDIA_SENTINEL must be a plain file name/, bad);
    }
  });
});

describe('the client address', () => {
  const fakeRequest = ({ peer, cf, ip = peer }) => ({
    headers: cf === undefined ? {} : { 'cf-connecting-ip': cf },
    ip,
    raw: { socket: { remoteAddress: peer } },
  });

  test('compileTrust matches addresses, ranges and IPv4 peers on dual-stack sockets', () => {
    const trust = compileTrust(['10.35.0.3', '192.168.0.0/16', 'fd00::/8']);
    assert.equal(trust('10.35.0.3'), true);
    assert.equal(trust('::ffff:10.35.0.3'), true);
    assert.equal(trust('10.35.0.4'), false);
    assert.equal(trust('192.168.44.2'), true);
    assert.equal(trust('fd12::1'), true);
    assert.equal(trust('2001:db8::1'), false);
    assert.equal(trust(''), false);
    assert.equal(trust(undefined), false);
    assert.equal(compileTrust(true)('203.0.113.9'), true);
    assert.equal(compileTrust(false)('10.35.0.3'), false);
    assert.equal(normalizeAddress('::FFFF:1.2.3.4'), '1.2.3.4');
  });

  test('CF-Connecting-IP counts only from a trusted proxy, and only when it is an address', () => {
    const trust = compileTrust(['10.35.0.3']);
    assert.equal(resolveClientIp(fakeRequest({ peer: '10.35.0.3', cf: '203.0.113.9' }), trust), '203.0.113.9');
    assert.equal(resolveClientIp(fakeRequest({ peer: '10.35.0.3', cf: '2001:db8::7' }), trust), '2001:db8::7');
    assert.equal(resolveClientIp(fakeRequest({ peer: '10.35.0.1', cf: '203.0.113.9' }), trust), '10.35.0.1', 'spoofed from the box');
    assert.equal(resolveClientIp(fakeRequest({ peer: '10.35.0.3', cf: '203.0.113.9, 1.1.1.1' }), trust), '10.35.0.3');
    assert.equal(resolveClientIp(fakeRequest({ peer: '10.35.0.3', cf: 'x'.repeat(100) }), trust), '10.35.0.3');
    assert.equal(resolveClientIp(fakeRequest({ peer: '10.35.0.3' }), trust), '10.35.0.3');
  });

  test('rate-limit keys group an IPv6 client by its /64', () => {
    const key = (ip) => rateLimitKey({ clientIp: ip });
    assert.equal(key('203.0.113.9'), '203.0.113.9');
    assert.equal(key('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(key('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64');
    assert.equal(key('2001:0db8:0001:0002::9'), '2001:db8:1:2::/64');
    assert.equal(key('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(key('::1'), '0:0:0:0::/64');
  });
});

// Throwaway routes: who does the app think is asking, and a tight limit.
async function whoRoutes(app) {
  app.get('/t/ip', async (request) => ({ clientIp: request.clientIp, helper: clientIp(request), ip: request.ip }));
  app.get('/t/limited', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
}

describe('the app behind the tunnel (TRUST_PROXY=10.35.0.3)', () => {
  let t;
  before(async () => {
    t = await makeTestApp({ env: { TRUST_PROXY: '10.35.0.3' }, plugins: [whoRoutes] });
  });
  after(async () => {
    await t.cleanup();
  });

  const ask = (url, remoteAddress, headers = {}) => t.app.inject({ url, remoteAddress, headers });

  test('request.clientIp is the visitor behind the tunnel, never a spoofed header', async () => {
    let res = await ask('/t/ip', '10.35.0.3', { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' });
    assert.deepEqual(res.json(), { clientIp: '203.0.113.9', helper: '203.0.113.9', ip: '203.0.113.9' });

    res = await ask('/t/ip', '10.35.0.1', { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.1' });
    assert.deepEqual(res.json(), { clientIp: '10.35.0.1', helper: '10.35.0.1', ip: '10.35.0.1' });
  });

  test('rate limits count each visitor, not the tunnel', async () => {
    const viaTunnel = (ip) => ask('/t/limited', '10.35.0.3', { 'cf-connecting-ip': ip });
    assert.equal((await viaTunnel('203.0.113.20')).statusCode, 200);
    assert.equal((await viaTunnel('203.0.113.20')).statusCode, 429);
    assert.equal((await viaTunnel('203.0.113.21')).statusCode, 200, 'someone else behind the same tunnel');

    // From an untrusted peer the header changes nothing: one budget per peer.
    const spoofed = (ip) => ask('/t/limited', '10.35.0.9', { 'cf-connecting-ip': ip });
    assert.equal((await spoofed('198.51.100.1')).statusCode, 200);
    assert.equal((await spoofed('198.51.100.2')).statusCode, 429);
  });
});

describe('TRUST_PROXY off (development and tests)', () => {
  let t;
  before(async () => {
    t = await makeTestApp({ plugins: [whoRoutes] });
  });
  after(async () => {
    await t.cleanup();
  });

  test('the header is ignored', async () => {
    const res = await t.app.inject({ url: '/t/ip', remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.equal(res.json().clientIp, '127.0.0.1');
  });
});

describe('the photo drive sentinel', () => {
  let tempDir;
  before(async () => {
    tempDir = await makeTempDir('gma-deploy-');
  });
  after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  test('storage.init refuses an unmounted drive and creates nothing there', async () => {
    const mediaDir = path.join(tempDir, 'unmounted');
    await fsp.mkdir(mediaDir);
    const storage = createStorage(mediaDir, { sentinel: '.gma-media' });
    await assert.rejects(storage.init(), (err) => {
      assert.ok(err instanceof MediaNotMountedError);
      assert.equal(err.code, 'media_not_mounted');
      assert.match(err.message, /has no \.gma-media file/);
      assert.match(err.message, /unplugged or unmounted/);
      return true;
    });
    assert.deepEqual(await fsp.readdir(mediaDir), []);
    assert.throws(() => assertMediaMounted(path.join(tempDir, 'missing-mount'), '.gma-media'), MediaNotMountedError);
  });

  test('with the sentinel, init makes the folders, the backups folder included', async () => {
    const mediaDir = path.join(tempDir, 'mounted');
    await fsp.mkdir(mediaDir);
    await fsp.writeFile(path.join(mediaDir, '.gma-media'), '');
    const storage = createStorage(mediaDir, { sentinel: '.gma-media' });
    await storage.init();
    assert.deepEqual((await fsp.readdir(mediaDir)).sort(), ['.gma-media', 'backups', 'originals', 'renditions', 'uploads']);
    assert.equal(storage.backupsDir, path.join(mediaDir, 'backups'));
    assert.doesNotThrow(() => assertMediaMounted(mediaDir, '.gma-media'));
    assert.doesNotThrow(() => assertMediaMounted(path.join(tempDir, 'nope'), ''), 'no sentinel configured, no check');
  });

  test('buildApp refuses before it opens or creates the database', async () => {
    const dir = path.join(tempDir, 'app');
    const config = makeTestConfig(dir, { MEDIA_SENTINEL: '.gma-media' });
    await assert.rejects(buildApp(config), MediaNotMountedError);
    assert.equal(fs.existsSync(config.dbPath), false);
    assert.equal(fs.existsSync(path.join(config.mediaDir, 'originals')), false);
  });

  // The real entry points, as the containers start them.
  function start(script, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${script} did not exit: ${output}`));
      }, 15_000);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }

  for (const script of ['src/index.js', 'src/worker.js']) {
    test(`${script} exits 78 with a clear line when the drive is missing`, async () => {
      const dir = path.join(tempDir, path.basename(script, '.js'));
      const mediaDir = path.join(dir, 'media');
      await fsp.mkdir(mediaDir, { recursive: true });
      const env = {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        PUBLIC_URL: 'https://gma.4mn.org',
        SECRET_KEY: STRONG_SECRET,
        DATA_DIR: path.join(dir, 'data'),
        MEDIA_DIR: mediaDir,
        HOST: '127.0.0.1',
        PORT: '0',
        LOG_LEVEL: 'silent',
      };
      const { code, output } = await start(script, env);
      assert.equal(code, 78, output);
      assert.match(output, /has no \.gma-media file, so the photo drive looks unplugged or unmounted/);
      assert.deepEqual(await fsp.readdir(mediaDir), [], 'nothing written where the drive should be');
      assert.equal(fs.existsSync(path.join(dir, 'data', 'gma.sqlite')), false);
    });
  }
});

describe('deployment files', () => {
  const compose = read('docker-compose.yml');

  test('one compose file, at the repo root', () => {
    assert.equal(fs.existsSync(path.join(REPO, 'deploy', 'docker-compose.yml')), false);
    assert.match(compose, /^name: gma$/m);
  });

  test('nothing is published beyond the box, and the containers are locked down', () => {
    const published = [...compose.matchAll(/^\s+- "([^"]+:\d+)"\s*(#.*)?$/gm)].map((m) => m[1]).filter((p) => /^\S+:\d+:\d+$/.test(p));
    assert.deepEqual(published, ['127.0.0.1:3064:8080']);
    assert.equal(compose.match(/^\s+user: "1000:1000"$/gm)?.length, 2, 'the shared block and the tunnel');
    assert.match(compose, /^\s+read_only: true/m);
    assert.equal(compose.match(/^\s+- no-new-privileges:true$/gm)?.length, 2);
    assert.equal(compose.match(/^\s+- ALL$/gm)?.length, 2, 'cap_drop ALL for the shared block and the tunnel');
    for (const name of ['gma-app', 'gma-worker', 'gma-tunnel']) assert.match(compose, new RegExp(`container_name: ${name}$`, 'm'));
    assert.match(compose, /^\s+cpus: 3$/m);
    // Memory and process limits on every container: the box is shared (SEC-5).
    assert.deepEqual([...compose.matchAll(/^\s+mem_limit: (\S+)$/gm)].map((m) => m[1]), ['1g', '3g', '256m']);
    assert.deepEqual([...compose.matchAll(/^\s+memswap_limit: (\S+)$/gm)].map((m) => m[1]), ['1g', '3g']);
    assert.equal(compose.match(/^\s+pids_limit: \d+$/gm)?.length, 3);
  });

  test('the app trusts only the tunnel, whose address is pinned', () => {
    const trusted = /TRUST_PROXY: (\S+)/.exec(compose)?.[1];
    const tunnelBlock = compose.slice(compose.indexOf('\n  tunnel:'), compose.indexOf('\nnetworks:'));
    const tunnelAddress = /ipv4_address: (\S+)/.exec(tunnelBlock)?.[1];
    assert.equal(trusted, '10.35.0.3');
    assert.equal(tunnelAddress, trusted);
    assert.deepEqual(parseTrustProxy(trusted, false), ['10.35.0.3']);
    assert.match(compose, /subnet: 10\.35\.0\.0\/24/);
  });

  test('media is the Seagate folder, guarded by the sentinel; the database stays on a named volume', () => {
    assert.match(compose, /MEDIA_SENTINEL: \.gma-media/);
    assert.match(compose, /type: none\n\s+o: bind\n\s+device: \/mnt\/seagate\/gma\/media/);
    assert.match(compose, /- gma_data:\/data/);
    assert.match(compose, /- gma_media:\/media/);
  });

  test('the tunnel follows the box convention', () => {
    assert.match(compose, /image: cloudflare\/cloudflared:2026\.9\.1@sha256:b269e8abd07a5bf6f3f4be65d5050b2174eca89c56a0241a8ff32a16aec454e4/);
    assert.match(compose, /command: tunnel --no-autoupdate --config \/etc\/cloudflared\/config\.yml run/);
    assert.match(compose, /- \.\/deploy\/cloudflared\.yml:\/etc\/cloudflared\/config\.yml:ro/);
    assert.match(compose, /- \$\{GMA_TUNNEL_CREDENTIALS:\?[^}]+\}:\/etc\/cloudflared\/credentials\.json:ro/);
    const tunnel = read('deploy/cloudflared.yml');
    assert.match(tunnel, /^tunnel: c0773eb4-ed3d-42bf-aa5e-d6fe842ab67b$/m);
    assert.match(tunnel, /^credentials-file: \/etc\/cloudflared\/credentials\.json$/m);
    const rules = [...tunnel.matchAll(/^\s+- (hostname|service): (\S+)/gm)].map((m) => `${m[1]}=${m[2]}`);
    assert.deepEqual(rules, ['hostname=gma.4mn.org', 'service=http_status:404']);
    assert.match(tunnel, /service: http:\/\/app:8080/);
  });

  test('.env.example mentions every key loadConfig reads, and the tunnel credentials', () => {
    const example = read('.env.example');
    const keys = new Set([...read('server/src/config.js').matchAll(/env(?:\.|, ')([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
    assert.ok(keys.size > 15);
    for (const key of keys) assert.match(example, new RegExp(`\\b${key}\\b`), key);
    assert.match(example, /^GMA_TUNNEL_CREDENTIALS=\/home\/ben\/\.cloudflared\/c0773eb4-ed3d-42bf-aa5e-d6fe842ab67b\.json$/m);
    assert.match(example, /^EMAIL_TRANSPORT=console$/m);
  });

  test('the image has the tools the media code looks for', () => {
    const dockerfile = read('Dockerfile');
    assert.match(dockerfile, /libheif-examples/);
    assert.match(dockerfile, /libheif-plugin-libde265/);
    assert.match(dockerfile, /\bffmpeg\b/);
    assert.match(dockerfile, new RegExp(`command -v[^\\n]*\\b${BINARIES.heifDec}\\b`));
    assert.match(dockerfile, /^USER 1000:1000$/m);
    assert.match(dockerfile, /NPM_CONFIG_CACHE=\/tmp\//);
  });
});
