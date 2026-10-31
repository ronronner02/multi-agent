'use strict';
/**
 * Unit tests for the pure decisions behind the desktop window.
 *
 * Nothing here starts WSL, clones a repository or elevates anything: every case feeds the
 * parser or the argv builder a value the real command produces, and checks what the app
 * would decide. The UTF-16 fixtures are the shapes `wsl.exe` actually emits, including the
 * BOM and the NUL between characters.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DAEMON_ORIGIN, cloneAndSetupArgv, decodeWslOutput, decideWsl, enableUiArgv, installArgv,
  isAllowedNavigation, listQuietArgv, listVerboseArgv, mintPairingArgv, normalizeRepoPath,
  parseDistroList, parseDistroTable, parsePairingCode, probeRepoArgv,
  setupArgv, startArgv, statusArgv, stopEngineArgv,
} = require('../src/wsl.js');

/** Encode text the way `wsl.exe` does: UTF-16LE, with a BOM. */
function utf16(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

test('decodes UTF-16LE console output and keeps non-ASCII text intact', () => {
  const buffer = utf16('Ubuntu\r\ndocker-desktop\r\n');
  assert.equal(decodeWslOutput(buffer), 'Ubuntu\r\ndocker-desktop\r\n');
  assert.equal(decodeWslOutput(utf16('默认发行版: Ubuntu')), '默认发行版: Ubuntu');
});

test('falls back to UTF-8 when the output has no NUL bytes', () => {
  assert.equal(decodeWslOutput(Buffer.from('Ubuntu\n', 'utf8')), 'Ubuntu\n');
  assert.equal(decodeWslOutput(Buffer.alloc(0)), '');
  assert.equal(decodeWslOutput(null), '');
});

test('parses the plain distro list, including the default marker', () => {
  assert.deepEqual(parseDistroList(utf16('Ubuntu\r\ndocker-desktop\r\n')), [
    { name: 'Ubuntu', isDefault: false },
    { name: 'docker-desktop', isDefault: false },
  ]);
  assert.deepEqual(parseDistroList(utf16('* Ubuntu\r\n  docker-desktop\r\n')), [
    { name: 'Ubuntu', isDefault: true },
    { name: 'docker-desktop', isDefault: false },
  ]);
  assert.deepEqual(parseDistroList(utf16('\r\n\r\n')), []);
});

test('parses the verbose table and skips its header', () => {
  const table = utf16('  NAME              STATE           VERSION\r\n* Ubuntu            Running         2\r\n  docker-desktop    Stopped         2\r\n');
  assert.deepEqual(parseDistroTable(table), [
    { name: 'Ubuntu', state: 'Running', version: 2, isDefault: true },
    { name: 'docker-desktop', state: 'Stopped', version: 2, isDefault: false },
  ]);
});

test('decides WSL is missing when neither probe answers', () => {
  assert.deepEqual(decideWsl({ statusOk: false, distros: [], table: [] }), { kind: 'wsl-missing' });
});

test('decides no distro is installed when the list is empty', () => {
  assert.deepEqual(decideWsl({ statusOk: true, distros: [], table: [] }), { kind: 'no-distro' });
});

test('prefers the default WSL2 distro and reports its version', () => {
  const decision = decideWsl({
    statusOk: true,
    distros: [{ name: 'Ubuntu', isDefault: false }, { name: 'Debian', isDefault: true }],
    table: [{ name: 'Ubuntu', state: 'Running', version: 2, isDefault: false }, { name: 'Debian', state: 'Stopped', version: 2, isDefault: true }],
  });
  assert.deepEqual(decision, { kind: 'ready', distro: 'Debian', version: 2 });
});

test('falls back to any WSL2 distro when the default one is WSL1', () => {
  const decision = decideWsl({
    statusOk: true,
    distros: [{ name: 'Legacy', isDefault: true }, { name: 'Ubuntu', isDefault: false }],
    table: [{ name: 'Legacy', state: 'Running', version: 1, isDefault: true }, { name: 'Ubuntu', state: 'Running', version: 2, isDefault: false }],
  });
  assert.deepEqual(decision, { kind: 'ready', distro: 'Ubuntu', version: 2 });
});

test('reports WSL1 when every installed distro is version 1', () => {
  const decision = decideWsl({
    statusOk: true,
    distros: [{ name: 'Legacy', isDefault: true }],
    table: [{ name: 'Legacy', state: 'Running', version: 1, isDefault: true }],
  });
  assert.deepEqual(decision, { kind: 'wsl1', distro: 'Legacy' });
});

test('uses the list when the version table is unreadable', () => {
  const decision = decideWsl({ statusOk: true, distros: [{ name: 'Ubuntu', isDefault: true }], table: [] });
  assert.deepEqual(decision, { kind: 'ready', distro: 'Ubuntu', version: null });
});

test('accepts only an absolute repository path', () => {
  assert.equal(normalizeRepoPath('/home/leo/multi-agent'), '/home/leo/multi-agent');
  assert.equal(normalizeRepoPath('  /home/leo/multi-agent/  '), '/home/leo/multi-agent');
  assert.equal(normalizeRepoPath('~/multi-agent'), null);
  assert.equal(normalizeRepoPath('multi-agent'), null);
  assert.equal(normalizeRepoPath('/home/leo/../etc'), null);
  assert.equal(normalizeRepoPath('/home/leo/multi-agent; rm -rf /'), null);
  assert.equal(normalizeRepoPath(42), null);
  assert.equal(normalizeRepoPath(''), null);
});

test('every in-distro command goes through -e and never through a shell string', () => {
  const commands = [
    probeRepoArgv('Ubuntu', '/home/leo/multi-agent'),
    setupArgv('Ubuntu', '/home/leo/multi-agent'),
    startArgv('Ubuntu', '/home/leo/multi-agent'),
    enableUiArgv('Ubuntu', '/home/leo/multi-agent'),
    stopEngineArgv('Ubuntu', '/home/leo/multi-agent'),
    cloneAndSetupArgv('Ubuntu'),
    mintPairingArgv('Ubuntu'),
  ];
  for (const argv of commands) {
    assert.equal(argv[0], '-d');
    assert.equal(argv[1], 'Ubuntu');
    assert.equal(argv[2], '-e');
    // WSL's outer shell is what expands `$VAR` to empty; `-e` skips it entirely.
    assert.ok(!argv.includes('--'), `${argv.join(' ')} must not use --`);
  }
});

test('the repository path is passed as an argv element, not interpolated into the script', () => {
  const argv = probeRepoArgv('Ubuntu', '/home/leo/multi-agent');
  assert.equal(argv.at(-1), '/home/leo/multi-agent');
  assert.ok(!argv[5].includes('/home/leo/multi-agent'));
  assert.equal(startArgv('Ubuntu', '/home/leo/multi-agent').at(-1), '/home/leo/multi-agent');
  assert.equal(stopEngineArgv('Ubuntu', '/srv/multi-agent').at(-1), '/srv/multi-agent');
});

test('the mint command never echoes the owner token', () => {
  const script = mintPairingArgv('Ubuntu')[5];
  assert.ok(script.includes('owner.env'));
  // The token reaches exactly one place: an Authorization header on the loopback call.
  assert.ok(script.includes('Authorization: Bearer $tok'));
  assert.ok(!script.includes('echo $tok') && !script.includes('printf $tok'));
});

test('the install command elevates a fixed command string', () => {
  assert.deepEqual(installArgv(), ['-NoProfile', '-Command', 'Start-Process wsl.exe -ArgumentList \'--install\' -Verb RunAs -Wait']);
  assert.deepEqual(statusArgv(), ['--status']);
  assert.deepEqual(listVerboseArgv(), ['-l', '-v']);
  assert.deepEqual(listQuietArgv(), ['-l', '-q']);
});

test('extracts a pairing code and rejects anything that is not one', () => {
  assert.equal(parsePairingCode('{"code":"' + 'a'.repeat(43) + '","expiresAt":1}'), 'a'.repeat(43));
  assert.equal(parsePairingCode('{"code":"short"}'), null);
  assert.equal(parsePairingCode('missing-owner-env'), null);
  assert.equal(parsePairingCode(''), null);
});

test('allows only the daemon origin', () => {
  assert.equal(isAllowedNavigation('http://127.0.0.1:7433/team'), true);
  assert.equal(isAllowedNavigation('http://127.0.0.1:7433/team/overview'), true);
  assert.equal(isAllowedNavigation('https://example.com/'), false);
  assert.equal(isAllowedNavigation('http://127.0.0.1:9999/team'), false);
  assert.equal(isAllowedNavigation('http://localhost:7433/team'), false);
  assert.equal(isAllowedNavigation('file:///C:/Windows/System32/calc.exe'), false);
  assert.equal(isAllowedNavigation('javascript:alert(1)'), false);
  assert.equal(isAllowedNavigation('not a url'), false);
  assert.equal(isAllowedNavigation('', DAEMON_ORIGIN), false);
});
