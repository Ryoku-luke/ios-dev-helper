/**
 * Guards the version stamp.
 *
 * A Host that keeps serving a cached plugin module looks exactly like a healthy one
 * from the outside, so the stamp is the cheapest answer to "which build is the running
 * Host actually holding?" — which is why it is worth a test: a tool registered without
 * it would silently remove that answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeContext, sectionHeading } from './support/harness.mjs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('every tool description ends with the version stamp of this package', () => {
  const { registry } = makeContext();
  assert.equal(registry.size, 9, 'the plugin registers nine tools');
  for (const [name, definition] of registry) {
    assert.equal(
      definition.description.endsWith(`[ios-dev-helper v${version}]`),
      true,
      `${name} must end with the version stamp`,
    );
  }
});

test('the guidance section heading names the version too', () => {
  const { section } = makeContext();
  assert.equal(sectionHeading(section), `## iOS development conventions (ios-dev-helper v${version})`);
});
