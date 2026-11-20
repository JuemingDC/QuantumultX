import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const parser = readFileSync(process.env.QX_PARSER ?? new URL('../Scripts/resource-parser.js', import.meta.url), 'utf8');
const url = '${url}';
const target = String.raw`/^https:\/\/example\.test\/api/`;
const rewrite = (phase, actions, pattern = target) =>
  phase + ' if ' + url + ' ~= ' + pattern + ' then ' + actions;
const script = (path, options = '') =>
  rewrite('response', 'script(' + JSON.stringify(path) + ')' + (options ? ' with ' + options : ''));

function parse(content, { build = 965, fragment = '' } = {}) {
  const results = [];
  const notices = [];
  runInNewContext(parser, {
    $environment: { version: 'Quantumult X build' + build },
    $resource: { type: 'rewrite', content, link: 'https://example.test/resource.lpx' + fragment, tag: 'Review' },
    $done: result => results.push(result.content),
    $notify: (...args) => notices.push(args.join('\n')),
    console: { log() {} }
  }, { timeout: 3000 });
  assert.ok(results.length > 0);
  return {
    lines: (results[0] || '').split('\n').filter(Boolean),
    notices: notices.join('\n')
  };
}

test('Loon blocks all request and response mutations targeting HTTP framing headers', () => {
  for (const phase of ['request', 'response']) {
    for (const action of [
      'add("CONTENT-Length", "5")',
      'set("Transfer-Encoding", "chunked")',
      'del(["X-Safe", "content-length"])',
      'replace("tRaNsFeR-EnCoDiNg", /abc/, "other")',
      'add(["X-Safe", "transfer-encoding"], ["a", "b"])',
      'set(["X-Safe", "CONTENT-LENGTH"], ["a", "b"])',
      'replace(["X-Safe", "CONTENT-LENGTH"], [/a/, /b/], ["c", "d"])'
    ]) {
      const output = parse('[Rewrite]\n' + rewrite(phase, phase + '.header.' + action));
      assert.deepEqual(output.lines, [], action);
      assert.match(output.notices, /分帧头.*(?:content-length|transfer-encoding)/i, action);
    }
    const safe = parse('[Rewrite]\n' + rewrite(phase, phase + '.header.add("X-Safe", "a")'));
    assert.equal(safe.lines.length, 1);
    assert.match(safe.lines[0], /X-Safe: a/);
  }
  const pipeline = parse(rewrite('request', 'request.header.add("X-Safe", "a") | request.header.add("content-length", "5")'));
  assert.deepEqual(pipeline.lines, []);
  assert.match(pipeline.notices, /分帧头/);
});

test('jq entries keep A, B, A source order and a declaration keeps its own action pipeline', () => {
  const output = parse([
    '[Rewrite]',
    rewrite('response', 'response.json.jq(`.x = 1`)'),
    rewrite('response', 'response.json.jq(`.x = 2`)', String.raw`/^https:\/\/example\.test\//`),
    rewrite('response', 'response.json.jq(`.x = 3`)'),
    rewrite('response', 'response.json.jq(`.x += 1`) | response.json.jq(`.y = .x`)')
  ].join('\n'));
  assert.equal(output.lines.length, 4);
  const programs = output.lines.map(line => {
    const match = line.match(/ jsonjq-response-body '(.*)'$/);
    assert.ok(match, line);
    return match[1];
  });
  let payload = '{}';
  assert.deepEqual(programs.map(program => {
    payload = execFileSync('jq', ['-c', program], { input: payload, encoding: 'utf8' });
    return JSON.parse(payload);
  }), [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4, y: 4 }]);
});

test('identical Loon V2 jq rows survive deduplication after filtering', () => {
  const first = rewrite('response', 'response.json.jq(`.x = 1`)');
  const second = rewrite('response', 'response.json.jq(`.x = 2`)');
  const dropped = rewrite('response', 'response.json.jq(`.drop = true`)');
  const native = "^https://other.example/ url jsonjq-response-body '.y = 1'";
  const input = ['[Rewrite]', dropped, native, first, second, first, native].join('\n');
  const output = parse(input, { fragment: '#regout=drop' });
  const a = parse(first).lines[0];
  const b = parse(second).lines[0];
  assert.ok(a && b);
  assert.deepEqual(output.lines, [parse(native).lines[0], a, b, a]);
});

test('native rewrites keep upstream regex filtering behavior', () => {
  const input = '^https://example.test/api url reject';
  assert.deepEqual(parse(input, { fragment: '#regex=%5Ehttps' }).lines, ['https://example.test/api url reject']);
  assert.deepEqual(parse(input, { fragment: '#regex=%5Enomatch' }).lines, []);
});

test('mixed filters following a Script section continue through upstream conversion', () => {
  const output = parse('[Script]\nDOMAIN-SUFFIX, example.test, REJECT\n[Rewrite]\n' +
    rewrite('request', 'reject(404)'));
  assert.equal(output.lines.length, 2);
  assert.match(output.lines[0], /^host-suffix, example\.test, REJECT$/i);
  assert.match(output.lines[1], / url reject$/);
});

test('Loon Script V2 follows legacy declarations and reports omitted runtime options', () => {
  for (const [options, reason] of [
    ['binary_body_mode=true', /binary_body_mode=true/],
    ['timeout=15', /timeout/],
    ['timeout=${timeout}', /timeout/],
    ['debug=true', /debug/],
    ['debug=${verbose}', /debug/]
  ]) {
    const output = parse('[Script]\n' + script('https://example.test/script.js', options));
    assert.equal(output.lines.length, 1, options);
    assert.match(output.lines[0], / url script-response-header https:\/\/example\.test\/script\.js$/, options);
    assert.match(output.notices, reason);
  }
  for (const phase of ['request', 'response']) {
    for (const requiresBody of [false, true]) {
      const type = 'http-' + phase;
      const url = 'https://example.test/script.js';
      const pattern = 'https://example\\.test/api';
      const params = 'script-path=' + url + ',requires-body=' + requiresBody +
        ',binary-body-mode=true,timeout=15,debug=true';
      const namedLegacy = parse('[Script]\nlegacy = type=' + type + ',pattern=' + pattern + ',' + params).lines;
      const positionalLegacy = parse('[Script]\n' + type + ' ' + pattern + ' ' + params).lines;
      const v2 = rewrite(phase, 'script("' + url + '") with requires_body=' + requiresBody +
        ', binary_body_mode=true, timeout=15, debug=true', String.raw`/https:\/\/example\.test\/api/`);
      assert.equal(namedLegacy.length, 1);
      assert.deepEqual(positionalLegacy, namedLegacy);
      assert.deepEqual(parse('[Script]\n' + v2).lines.map(line => line.replace(/\\\//g, '/')), namedLegacy);
    }
  }
  const http = parse('[Script]\n' + script('http://example.test/script.js'));
  assert.deepEqual(http.lines, []);
  assert.match(http.notices, /HTTPS/);
  const output = parse([
    '[Script]',
    script('https://example.test/script.js', 'debug=false, binary_body_mode=false, requires_body=true'),
    script('local/one.js'),
    script('disabled.js', 'enable=false')
  ].join('\n'));
  assert.equal(output.lines.length, 2);
  assert.match(output.lines[0], /script-response-body https:\/\/example\.test\/script\.js$/);
  assert.match(output.lines[1], /script-response-header local\/one\.js$/);
});

test('only supported Loon rewrite actions are emitted with the matching phase', () => {
  const json = rewrite('response', 'response.json.jq(`.x = 1`)');
  assert.match(parse(json).lines[0], /jsonjq-response-body/);
  const old = parse(json, { build: 844 });
  assert.deepEqual(old.lines, []);
  assert.match(old.notices, /845/);
  assert.match(parse(rewrite('request', 'reject(404)')).lines[0], / url reject$/);
  const unsupported = parse(rewrite('response', 'response.body.mock_file("json", "local.json", 200)'));
  assert.deepEqual(unsupported.lines, []);
  assert.match(unsupported.notices, /mock_file/);
});
