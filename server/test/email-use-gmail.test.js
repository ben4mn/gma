// deploy/use-gmail.sh, run against a throwaway copy of /home/ben/gma with a
// fake `docker` first on PATH: which key names it finds in another project's
// .env, what it writes into gma's .env (0600, with a 0600 backup), and that
// the password never reaches stdout, stderr, a command line or a child's env.
//
// The script isn't in the image; the CI mounts deploy/ where this looks for it
// and the test skips (saying why) when it's missing, like deploy.test.js.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'deploy', 'use-gmail.sh');
const HAVE_SCRIPT = fs.existsSync(SCRIPT);
const HAVE_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const SKIP = !HAVE_SCRIPT ? `${SCRIPT} isn't here (the image doesn't contain deploy/)` : !HAVE_BASH ? 'no bash' : false;

const PASS = 'abcdwxyzefghmnop';
const GMA_ENV = [
  '# gma',
  'PUBLIC_URL=https://gma.4mn.org',
  'SECRET_KEY=c2VjcmV0',
  '',
  '# Sign-in codes by email: console | resend',
  'EMAIL_TRANSPORT=console',
  'RESEND_API_KEY=',
  "EMAIL_FROM=Grandma's family <hello@auth.4mn.org>",
  'EMAIL_TRANSPORT=resend',
  'VAPID_SUBJECT=mailto:ben@example.com',
  'LOG_LEVEL=info',
].join('\n');

const FAKE_DOCKER = `#!/bin/bash
printf '%s|%s\\n' "$(pwd -P)" "$*" >> "$FAKE_DOCKER_LOG"
env >> "$FAKE_DOCKER_ENV"
case "$1" in
  run) [[ \${FAKE_DOCKER_OLD_IMAGE:-} == 1 ]] && exit 3; exit 0 ;;
  inspect) echo "\${FAKE_DOCKER_HEALTH:-0 healthy}"; exit 0 ;;
  compose)
    case "$2" in
      up) exit "\${FAKE_DOCKER_UP_STATUS:-0}" ;;
      exec) echo "\${FAKE_DOCKER_EXEC_OUT:-sent}"; exit "\${FAKE_DOCKER_EXEC_STATUS:-0}" ;;
    esac ;;
esac
exit 0
`;

const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

// A copy of the repo's layout: <root>/deploy/use-gmail.sh and <root>/.env.
function makeBox({ gmaEnv = GMA_ENV, other = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gma-use-gmail-')));
  temps.push(dir);
  const root = path.join(dir, 'gma');
  fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'deploy', 'use-gmail.sh'));
  if (gmaEnv !== null) fs.writeFileSync(path.join(root, '.env'), gmaEnv, { mode: 0o600 });
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  let otherPath = null;
  if (other !== null) {
    otherPath = path.join(dir, 'secretsanta', '.env');
    fs.mkdirSync(path.dirname(otherPath));
    fs.writeFileSync(otherPath, other, { mode: 0o600 });
  }
  return { dir, root, bin, otherPath, log: path.join(dir, 'docker.log'), childEnv: path.join(dir, 'docker.env') };
}

function run(box, args = [], { input = '\n', env = {} } = {}) {
  const result = spawnSync('bash', [path.join(box.root, 'deploy', 'use-gmail.sh'), ...args], {
    cwd: box.root,
    input,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: `${box.bin}:${process.env.PATH}`,
      HOME: box.dir,
      FAKE_DOCKER_LOG: box.log,
      FAKE_DOCKER_ENV: box.childEnv,
      ...env,
    },
  });
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return {
    ...result,
    output: `${result.stdout}${result.stderr}`,
    docker: read(box.log)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [cwd, ...rest] = line.split('|');
        return { cwd, args: rest.join('|') };
      }),
    dockerEnv: read(box.childEnv),
    gmaEnv: read(path.join(box.root, '.env')),
  };
}

function backups(box) {
  return fs.readdirSync(box.root).filter((name) => name.startsWith('.env.bak-'));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function assertNeverShown(result, secret = PASS) {
  assert.ok(!result.output.includes(secret), `the password reached the terminal:\n${result.output}`);
  for (const call of result.docker) assert.ok(!call.args.includes(secret), `the password was on docker's command line: ${call.args}`);
  assert.ok(!result.dockerEnv.includes(secret), "the password was in docker's environment");
}

describe('deploy/use-gmail.sh', { skip: SKIP }, () => {
  test('bash -n is clean, and it never turns on tracing', () => {
    const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const text = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(text, /^set -euo pipefail$/m);
    assert.doesNotMatch(text, /^\s*set -[a-z]*x/m);
    assert.doesNotMatch(text, /\bsource\b|^\s*\.\s/m);
  });

  test('finds SMTP_USER / SMTP_PASS in another project, rewrites .env in place, restarts, sends the test', () => {
    const box = makeBox({
      other: ['# secretsanta', 'NODE_ENV=production', 'export SMTP_USER="santa.4mn@gmail.com"', `SMTP_PASS='${PASS}'`, 'SMTP_HOST=smtp.gmail.com', ''].join('\r\n'),
    });
    const result = run(box, [box.otherPath], { input: 'ben@example.com\n' });
    assert.equal(result.status, 0, result.output);

    assert.match(result.stdout, /SMTP_USER/);
    assert.match(result.stdout, /SMTP_PASS/);
    assert.match(result.stdout, /santa\.4mn@gmail\.com/);
    assertNeverShown(result);

    const lines = result.gmaEnv.split('\n');
    // Other lines kept, in order; the six keys set once each, where they were.
    assert.deepEqual(lines.slice(0, 6), ['# gma', 'PUBLIC_URL=https://gma.4mn.org', 'SECRET_KEY=c2VjcmV0', '', '# Sign-in codes by email: console | resend', 'EMAIL_TRANSPORT=smtp']);
    assert.ok(lines.includes('RESEND_API_KEY='));
    assert.ok(lines.includes("EMAIL_FROM=Grandma's family <santa.4mn@gmail.com>"));
    assert.ok(lines.includes('VAPID_SUBJECT=mailto:ben@example.com'));
    assert.ok(lines.includes('LOG_LEVEL=info'));
    assert.ok(lines.includes('SMTP_HOST=smtp.gmail.com'));
    assert.ok(lines.includes('SMTP_PORT=465'));
    assert.ok(lines.includes('SMTP_USER=santa.4mn@gmail.com'));
    assert.ok(lines.includes(`SMTP_PASS=${PASS}`));
    assert.equal(lines.filter((l) => l.startsWith('EMAIL_TRANSPORT=')).length, 1, 'the duplicate EMAIL_TRANSPORT is gone');
    assert.equal(mode(path.join(box.root, '.env')), 0o600);

    const [backup] = backups(box);
    assert.ok(backup, 'a backup was made');
    assert.match(backup, /^\.env\.bak-\d{8}-\d{6}$/);
    assert.equal(fs.readFileSync(path.join(box.root, backup), 'utf8'), GMA_ENV);
    assert.equal(mode(path.join(box.root, backup)), 0o600);
    assert.deepEqual(fs.readdirSync(box.root).sort(), ['.env', backup, 'deploy'].sort(), 'no temp file left behind');

    const calls = result.docker.map((c) => c.args);
    assert.equal(calls[0], 'image inspect gma:local');
    assert.match(calls[1], /^run --rm --pull never --network none --entrypoint node gma:local -e /);
    assert.ok(calls.includes('compose up -d'));
    assert.ok(calls.some((c) => c.startsWith('inspect ') && c.endsWith(' gma-app')));
    assert.equal(calls.at(-1), 'compose exec -T app npm run -s email:test -- --to ben@example.com');
    for (const call of result.docker) assert.equal(call.cwd, box.root);
    assert.match(result.stdout, /\bsent\b/);
  });

  test('lower-case GMAIL_ADDRESS / gmail_app_password, a spaced app password in quotes', () => {
    const box = makeBox({
      other: ['gmail_address = santa.4mn@gmail.com', 'gmail_app_password="abcd wxyz efgh mnop"  # from Google', ''].join('\n'),
    });
    const result = run(box, [box.otherPath]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /gmail_address/);
    assert.match(result.stdout, /gmail_app_password/);
    assertNeverShown(result);
    assertNeverShown(result, 'abcd wxyz');
    assert.ok(result.gmaEnv.split('\n').includes(`SMTP_PASS=${PASS}`));
    assert.ok(result.gmaEnv.split('\n').includes('SMTP_USER=santa.4mn@gmail.com'));
    // Enter at the last question: no test email.
    assert.ok(!result.docker.some((c) => c.args.startsWith('compose exec')));
  });

  test('EMAIL_USER / EMAIL_PASS with single quotes and a comment; MAIL_* and SENDER_* too', () => {
    const styles = [
      [`EMAIL_USER='santa.4mn@gmail.com'\nEMAIL_PASS='${PASS}' # app password\n`, /EMAIL_USER/, /EMAIL_PASS/],
      [`MAIL_USERNAME=santa.4mn@gmail.com\nMAIL_PASSWORD=${PASS}\n`, /MAIL_USERNAME/, /MAIL_PASSWORD/],
      [`SENDER_EMAIL=santa.4mn@gmail.com\nSENDER_PASSWORD="${PASS}"`, /SENDER_EMAIL/, /SENDER_PASSWORD/],
      [`Email_Address=santa.4mn@gmail.com\nEmail_App_Password=${PASS}\n`, /Email_Address/, /Email_App_Password/],
    ];
    for (const [other, userKey, passKey] of styles) {
      const box = makeBox({ other });
      const result = run(box, [box.otherPath]);
      assert.equal(result.status, 0, result.output);
      assert.match(result.stdout, userKey);
      assert.match(result.stdout, passKey);
      assertNeverShown(result);
      assert.ok(result.gmaEnv.split('\n').includes(`SMTP_PASS=${PASS}`), other);
      assert.ok(result.gmaEnv.split('\n').includes('SMTP_USER=santa.4mn@gmail.com'), other);
    }
  });

  test('SMTP_* wins over the other names, whatever order the file has them in', () => {
    const box = makeBox({ other: `EMAIL_USER=old@gmail.com\nEMAIL_PASS=zzzzzzzzzzzzzzzz\nSMTP_USER=santa.4mn@gmail.com\nSMTP_PASS=${PASS}\n` });
    const result = run(box, [box.otherPath]);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.gmaEnv.includes(`SMTP_PASS=${PASS}\n`));
    assert.ok(result.gmaEnv.includes('SMTP_USER=santa.4mn@gmail.com\n'));
  });

  test('with no path it asks for the address, then the password (hidden)', () => {
    const box = makeBox();
    const result = run(box, [], { input: `santa.4mn@gmail.com\nabcd wxyz efgh mnop\n\n` });
    assert.equal(result.status, 0, result.output);
    assertNeverShown(result);
    assertNeverShown(result, 'abcd wxyz');
    assert.ok(result.gmaEnv.split('\n').includes(`SMTP_PASS=${PASS}`));
    assert.ok(result.gmaEnv.split('\n').includes('SMTP_USER=santa.4mn@gmail.com'));
  });

  test('asks only for what the other file lacks', () => {
    const box = makeBox({ other: 'GMAIL_USER=santa.4mn@gmail.com\nSOMETHING_ELSE=1\n' });
    const result = run(box, [box.otherPath], { input: `${PASS}\n\n` });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /GMAIL_USER/);
    assertNeverShown(result);
    assert.ok(result.gmaEnv.split('\n').includes(`SMTP_PASS=${PASS}`));
  });

  test('a password .env would mangle is single-quoted, with a warning that it is not an app password', () => {
    const odd = 'pa$$ #word!';
    const box = makeBox({ other: `SMTP_USER=santa.4mn@gmail.com\nSMTP_PASS="${odd}"\n` });
    const result = run(box, [box.otherPath]);
    assert.equal(result.status, 0, result.output);
    assertNeverShown(result, odd);
    assert.match(result.output, /app password/);
    assert.ok(result.gmaEnv.split('\n').includes(`SMTP_PASS='${odd}'`));
  });

  test('& / \\ $ " in a password are kept exactly, and every other line of .env survives', () => {
    const odd = 'a&b/c\\d$e`f"g';
    const box = makeBox({ other: 'SMTP_USER=santa.4mn@gmail.com\n' });
    const result = run(box, [box.otherPath], { input: `${odd}\n\n` });
    assert.equal(result.status, 0, result.output);
    assertNeverShown(result, odd);
    const lines = result.gmaEnv.split('\n');
    assert.ok(lines.includes(`SMTP_PASS='${odd}'`), result.gmaEnv);
    for (const kept of ['# gma', 'PUBLIC_URL=https://gma.4mn.org', 'SECRET_KEY=c2VjcmV0', 'VAPID_SUBJECT=mailto:ben@example.com', 'LOG_LEVEL=info']) {
      assert.ok(lines.includes(kept), kept);
    }
    assert.ok(result.gmaEnv.endsWith('\n'), 'ends with a newline');
  });

  test('a password ending in a backslash is refused: docker compose would read it as an escaped quote and swallow the lines after it', () => {
    for (const [other, input] of [
      [`SMTP_USER=santa.4mn@gmail.com\nSMTP_PASS='abcdwxyzefghmno\\'\n`, '\n'],
      ['SMTP_USER=santa.4mn@gmail.com\n', 'abcdwxyzefghmno\\\n\n'],
    ]) {
      const box = makeBox({ other });
      const result = run(box, [box.otherPath], { input });
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.stderr, /backslash/);
      assert.match(result.stderr, /Nothing was changed/);
      assert.equal(result.gmaEnv, GMA_ENV);
      assert.deepEqual(backups(box), []);
      assert.ok(!result.docker.some((c) => c.args.startsWith('compose')));
      assertNeverShown(result, 'abcdwxyzefghmno');
    }
  });

  test('an old SMTP_SECURE or port from an earlier try is replaced, so 465 always means implicit TLS', () => {
    const box = makeBox({
      gmaEnv: `${GMA_ENV}\nSMTP_HOST=smtp.example.com\nSMTP_PORT=587\nSMTP_SECURE=false\nexport SMTP_PASS=old\n`,
      other: `SMTP_USER=santa.4mn@gmail.com\nSMTP_PASS=${PASS}\n`,
    });
    const result = run(box, [box.otherPath]);
    assert.equal(result.status, 0, result.output);
    const lines = result.gmaEnv.split('\n');
    for (const want of ['SMTP_HOST=smtp.gmail.com', 'SMTP_PORT=465', 'SMTP_SECURE=true', `SMTP_PASS=${PASS}`]) {
      assert.equal(lines.filter((l) => l === want).length, 1, want);
    }
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_PASS', 'SMTP_USER', 'EMAIL_TRANSPORT', 'EMAIL_FROM']) {
      assert.equal(lines.filter((l) => l.replace(/^export\s+/, '').startsWith(`${key}=`)).length, 1, key);
    }
  });

  test('an image that cannot send through SMTP yet changes nothing', () => {
    const box = makeBox({ other: `SMTP_USER=santa.4mn@gmail.com\nSMTP_PASS=${PASS}\n` });
    const result = run(box, [box.otherPath], { env: { FAKE_DOCKER_OLD_IMAGE: '1' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docker compose up -d --build/);
    assert.equal(result.gmaEnv, GMA_ENV);
    assert.deepEqual(backups(box), []);
    assert.ok(!result.docker.some((c) => c.args.startsWith('compose')));
    assertNeverShown(result);
  });

  test('an app that does not come back healthy says how to undo it', () => {
    const box = makeBox({ other: `SMTP_USER=santa.4mn@gmail.com\nSMTP_PASS=${PASS}\n` });
    const result = run(box, [box.otherPath], { env: { FAKE_DOCKER_HEALTH: '0 unhealthy' } });
    assert.notEqual(result.status, 0);
    const [backup] = backups(box);
    assert.ok(result.stderr.includes(`cp ${backup} .env`), result.stderr);
    assertNeverShown(result);
  });

  test('a failed test email says so and how to undo it', () => {
    const box = makeBox({ other: `SMTP_USER=santa.4mn@gmail.com\nSMTP_PASS=${PASS}\n` });
    const result = run(box, [box.otherPath], {
      input: 'ben@example.com\n',
      env: { FAKE_DOCKER_EXEC_OUT: 'EmailError: The email server refused the sign-in (EAUTH 535)', FAKE_DOCKER_EXEC_STATUS: '1' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /EAUTH 535/);
    assert.match(result.stderr, /cp \.env\.bak-/);
    assertNeverShown(result);
  });

  test('refuses a bad address, a missing .env, an unreadable file and extra arguments', () => {
    const noEnv = makeBox({ gmaEnv: null });
    const missing = run(noEnv, []);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /\.env/);

    const box = makeBox();
    const unreadable = run(box, [path.join(box.dir, 'nope.env')]);
    assert.notEqual(unreadable.status, 0);
    assert.match(unreadable.stderr, /nope\.env/);

    const extra = run(box, ['a', 'b']);
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /Usage/);

    const badAddress = run(box, [], { input: `not an address\n${PASS}\n` });
    assert.notEqual(badAddress.status, 0);
    assert.match(badAddress.stderr, /address/);
    assert.equal(badAddress.gmaEnv, GMA_ENV);
    assertNeverShown(badAddress);
    assert.deepEqual(backups(box), []);
  });

  test('--find lists the .env files that hold a password, with the key names and never a value', () => {
    const box = makeBox();
    const home = path.join(box.dir, 'home');
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), text, { mode: 0o600 });
    };
    put('secretsanta/.env', `GMAIL_USER=santa.4mn@gmail.com\nGMAIL_APP_PASSWORD=${PASS}\n`);
    put('bachboys/server/.env.production', `EMAIL_PASS=zyxwvutsrqponmlk\n`);
    put('docket/.env', 'DATABASE_URL=postgres://x\n');
    put('encore/.env.example', 'SMTP_USER=you@gmail.com\nSMTP_PASS=your-app-password\n');
    put('deep/a/b/c/.env', `SMTP_PASS=${PASS}\n`);
    const result = run(box, ['--find', home]);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.stdout.includes(`${path.join(home, 'secretsanta/.env')}  (GMAIL_USER, GMAIL_APP_PASSWORD)`), result.stdout);
    assert.ok(result.stdout.includes(`${path.join(home, 'bachboys/server/.env.production')}  (no address, EMAIL_PASS)`), result.stdout);
    assert.ok(!result.stdout.includes('docket'));
    assert.ok(!result.stdout.includes('encore'), 'example files are skipped');
    assert.ok(!result.stdout.includes('deep/'), 'three levels down at most');
    assert.ok(!result.output.includes('zyxwvutsrqponmlk'));
    assertNeverShown(result);
    assert.deepEqual(result.docker, []);
    assert.equal(result.gmaEnv, GMA_ENV);
    assert.deepEqual(backups(box), []);
  });

  test('--help prints the usage and touches nothing', () => {
    const box = makeBox();
    const result = run(box, ['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: bash deploy\/use-gmail\.sh/);
    assert.deepEqual(result.docker, []);
  });
});
