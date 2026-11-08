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
  DAEMON_ORIGIN, PAIR_SCRIPT, cloneAndSetupArgv, decodeWslOutput, decideWsl, enableUiArgv,
  installArgv, isAllowedNavigation, isDaemonHealth, listQuietArgv, listVerboseArgv,
  nativeFolderToWsl, normalizeRepoPath, pairArgv, parseDistroList, parseDistroTable, parsePairingResult,
  probeRepoArgv, runtimeEnvironment, setupArgv, startArgv, statusArgv, stopEngineArgv,
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
    pairArgv('Ubuntu'),
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

test('the pairing script keeps both credentials inside the distro', () => {
  const argv = pairArgv('Ubuntu');
  assert.equal(argv[5], PAIR_SCRIPT);
  // The token reaches curl as a config on stdin, never as an argv element another local
  // user could read from the process command line.
  assert.ok(PAIR_SCRIPT.includes("printf 'header = \"Authorization: Bearer %s\"\\n' \"$tok\" | curl -sf --noproxy '*' -K -"));
  assert.ok(!PAIR_SCRIPT.includes('Authorization: Bearer $tok'));
  // Both halves of the exchange target the distro's own loopback.
  assert.ok(PAIR_SCRIPT.includes('base=http://127.0.0.1:7433'));
  assert.ok(PAIR_SCRIPT.includes('"$base/api/team-control/owner-session/pairing"'));
  assert.ok(PAIR_SCRIPT.includes('"$base/api/team-control/owner-session/exchange"'));
  // Nothing prints the token, and the app is told only the cookie and the anti-forgery token.
  assert.ok(!PAIR_SCRIPT.includes('echo "$tok"') && !PAIR_SCRIPT.includes('printf "$tok"'));
  assert.ok(PAIR_SCRIPT.trimEnd().endsWith(`printf 'cookie=%s\\ncsrf=%s\\n' "$cookie" "$csrf"`));
  // The one-time code never reaches the app either: it is consumed by the exchange above.
  assert.ok(!/^printf .*code=/m.test(PAIR_SCRIPT));
});

test('reads a complete pairing result and rejects a partial one', () => {
  const cookie = 'a'.repeat(43), csrf = 'b'.repeat(43);
  assert.deepEqual(parsePairingResult(`cookie=${cookie}\ncsrf=${csrf}\n`), { cookie, antiForgeryToken: csrf });
  assert.deepEqual(parsePairingResult(`cookie=${cookie}\r\ncsrf=${csrf}\r\n`), { cookie, antiForgeryToken: csrf });
  assert.equal(parsePairingResult(`cookie=${cookie}\n`), null);
  assert.equal(parsePairingResult(`csrf=${csrf}\n`), null);
  assert.equal(parsePairingResult('exchange-failed\n'), null);
  assert.equal(parsePairingResult('cookie=short\ncsrf=short\n'), null);
  assert.equal(parsePairingResult(''), null);
});

test('accepts only a body that is this daemon, not any 200', () => {
  const body = JSON.stringify({ status: 'ok', pid: 42, selfHostId: 'host-1', eventLoop: {} });
  assert.equal(isDaemonHealth(body), true);
  assert.equal(isDaemonHealth('{"status":"ok"}'), false);
  assert.equal(isDaemonHealth('{"status":"ok","pid":0,"selfHostId":"host-1"}'), false);
  assert.equal(isDaemonHealth('{"status":"ok","pid":42,"selfHostId":""}'), false);
  assert.equal(isDaemonHealth('{"status":"down","pid":42,"selfHostId":"host-1"}'), false);
  assert.equal(isDaemonHealth('<html>hello</html>'), false);
  assert.equal(isDaemonHealth('null'), false);
  assert.equal(isDaemonHealth('[]'), false);
  assert.equal(isDaemonHealth(''), false);
  assert.equal(isDaemonHealth(undefined), false);
});

test('the install command elevates a fixed command string', () => {
  assert.deepEqual(installArgv(), ['-NoProfile', '-Command', 'Start-Process wsl.exe -ArgumentList \'--install\' -Verb RunAs -Wait']);
  assert.deepEqual(statusArgv(), ['--status']);
  assert.deepEqual(listVerboseArgv(), ['-l', '-v']);
  assert.deepEqual(listQuietArgv(), ['-l', '-q']);
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


test('maps absolute Windows drive folders without changing path characters', () => {
  for (const [input, expected] of [
    [String.raw`D:\code\app`, '/mnt/d/code/app'],
    [String.raw`d:\Client Work\O'Reilly & $work; app`, "/mnt/d/Client Work/O'Reilly & $work; app"],
    ['C:\\Work\\\u65e5\u672c\u8a9e app\\', '/mnt/c/Work/\u65e5\u672c\u8a9e app'],
    ['D:/code/app', '/mnt/d/code/app'],
    ['D:\\', '/mnt/d'],
  ]) assert.equal(nativeFolderToWsl(input, 'Ubuntu'), expected);
});

test('maps only the complete selected WSL distro and preserves path case', () => {
  assert.equal(nativeFolderToWsl(String.raw`\\wsl.localhost\Ubuntu\home\dev\App`, 'Ubuntu'), '/home/dev/App');
  assert.equal(nativeFolderToWsl(String.raw`\\WSL.LOCALHOST\ubuntu\home\dev\App`, 'Ubuntu'), '/home/dev/App');
  assert.equal(nativeFolderToWsl(String.raw`\\wsl$\Ubuntu\home\dev\app`, 'Ubuntu'), '/home/dev/app');
  assert.equal(nativeFolderToWsl(String.raw`\\wsl.localhost\Debian\home\dev\app`, 'Ubuntu'), null);
  assert.equal(nativeFolderToWsl(String.raw`\\wsl.localhost\Ubuntu-Other\home\dev\app`, 'Ubuntu'), null);
});

test('rejects relative paths, unrelated shares and ambiguous native path forms', () => {
  for (const input of [null, 12, '', 'D:folder', 'folder', '/home/dev/app',
    String.raw`\\server\share\app`, String.raw`\\wsl.localhost`, '\\\\wsl.localhost\\',
    String.raw`\\?\D:\code\app`, String.raw`D:\code\..\app`,
    String.raw`\\wsl.localhost\Ubuntu\..\Debian\home\dev`, 'D:\\app\u0000tail']) {
    assert.equal(nativeFolderToWsl(input, 'Ubuntu'), null, String(input));
  }
  assert.equal(nativeFolderToWsl(String.raw`D:\code\app`, null), null);
});


test('a normal shortcut reuses the saved runtime profile without carrying tokens between profiles', () => {
  const inherited = { PATH: 'fixture-path', HTTPS_PROXY: 'http://fixture-proxy', WSLENV: 'WT_SESSION:GH_TOKEN/u:XDG_CONFIG_HOME/p',
    XDG_CONFIG_HOME: '/old/config', OPENRIG_DB: '/old/db', OPENRIG_HOME: '/old/home',
    GH_TOKEN: 'fixture-secret', MULTI_AGENT_OWNER_TOKEN: 'fixture-secret' };
  const profile = { XDG_CONFIG_HOME: '/fixture/config', GH_CONFIG_DIR: '/fixture/gh', OPENRIG_HOME: '/fixture/home',
    OPENRIG_DB: '/fixture/home/state.sqlite', OPENRIG_PORT: '7433', OPENRIG_HOST: '127.0.0.1',
    GH_TOKEN: 'ignored', PATH: '/ignored', NODE_OPTIONS: '--require ignored' };
  const env = runtimeEnvironment(inherited, profile);
  assert.equal(env.XDG_CONFIG_HOME, '/fixture/config');
  assert.equal(env.OPENRIG_DB, '/fixture/home/state.sqlite');
  assert.equal(env.PATH, inherited.PATH);
  assert.equal(env.HTTPS_PROXY, inherited.HTTPS_PROXY);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.MULTI_AGENT_OWNER_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.ok(env.WSLENV.split(':').includes('XDG_CONFIG_HOME/u'));
  assert.ok(!env.WSLENV.includes('GH_TOKEN') && !env.WSLENV.includes('XDG_CONFIG_HOME/p'));
  assert.equal(inherited.XDG_CONFIG_HOME, '/old/config');
});

test('the default profile keeps its existing launch environment and ignores malformed profile settings', () => {
  const inherited = { PATH: 'fixture', WSLENV: 'WT_SESSION', XDG_CONFIG_HOME: '/default' };
  assert.deepEqual(runtimeEnvironment(inherited, undefined), inherited);
  assert.deepEqual(runtimeEnvironment(inherited, []), inherited);
  const env = runtimeEnvironment(inherited, { XDG_CONFIG_HOME: 42, OPENRIG_DB: '/bad\0path' });
  assert.equal(env.OPENRIG_DB, undefined);
});
