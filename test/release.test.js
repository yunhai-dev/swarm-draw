import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = process.cwd();
const workflowDir = join(root, '.github', 'workflows');

const workflow = (name) => parse(readFileSync(join(workflowDir, name), 'utf8'));

test('workflows parse and keep the steps the release flow depends on', () => {
  const files = readdirSync(workflowDir).filter((file) => file.endsWith('.yml'));
  assert.deepEqual(files.sort(), ['ci.yml', 'pages.yml', 'publish.yml']);

  const ci = workflow('ci.yml');
  const ciSteps = ci.jobs.test.steps;
  assert.ok(ciSteps.some((step) => step.uses?.startsWith('actions/checkout')));
  assert.ok(ciSteps.some((step) => step.run === 'npm ci'));
  assert.ok(ciSteps.some((step) => step.run === 'npm test'));

  const publish = workflow('publish.yml');
  assert.equal(publish.permissions['id-token'], 'write', 'provenance needs the id token');
  const publishSteps = publish.jobs.publish.steps;
  assert.ok(
    publishSteps.some((step) => step.run?.includes('npm publish')),
    'the workflow publishes',
  );
  assert.ok(
    publishSteps.some((step) => step.run?.includes('npm install -g npm@latest')),
    'trusted publishing needs npm >= 11.5.1',
  );
  assert.ok(
    !publishSteps.some((step) => step.env?.NODE_AUTH_TOKEN),
    'trusted publishing uses OIDC, not a stored token',
  );
  assert.ok(
    publishSteps.some((step) => step.with?.node_version === 24 || step.with?.['node-version'] === 24),
    'runs on a node with a trusted-publishing capable npm',
  );

  const pages = workflow('pages.yml');
  assert.equal(pages.permissions.pages, 'write');
  const pagesSteps = pages.jobs.deploy.steps;
  assert.ok(pagesSteps.some((step) => step.uses?.startsWith('actions/upload-pages-artifact')));
  assert.ok(pagesSteps.some((step) => step.uses?.startsWith('actions/deploy-pages')));
});

test('the published package exposes the vanilla, react and vue entry points', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'swarm-draw');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.files, ['src']);
  for (const entry of ['.', './react', './vue']) {
    const target = pkg.exports[entry];
    assert.ok(existsSync(join(root, target)), entry + ' -> ' + target + ' must exist');
  }
  assert.equal(pkg.peerDependenciesMeta.react.optional, true);
  assert.equal(pkg.peerDependenciesMeta.vue.optional, true);

  // the tarball must contain everything the exports point at
  const packed = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  const [info] = JSON.parse(packed);
  const shipped = info.files.map((file) => file.path);
  for (const file of ['src/index.js', 'src/react.js', 'src/vue.js', 'src/detect.js', 'LICENSE', 'README.md']) {
    assert.ok(shipped.includes(file), file + ' is missing from the tarball');
  }
});

test('the Pages build produces a working static site', () => {
  execFileSync(process.execPath, [join(root, 'scripts', 'build-site.mjs')], { cwd: root, encoding: 'utf8' });

  const site = join(root, '_site');
  for (const file of ['index.html', 'demo/index.html', 'demo/auto.html', 'src/index.js', '.nojekyll']) {
    assert.ok(existsSync(join(site, file)), file + ' must be part of the site');
  }

  // demo pages import the library relatively; that path has to survive the copy
  const demo = readFileSync(join(site, 'demo', 'auto.html'), 'utf8');
  const imported = /import\s+\{[^}]+\}\s+from\s+'([^']+)'/.exec(demo);
  assert.ok(imported, 'demo imports the library');
  assert.ok(existsSync(join(site, 'demo', imported[1])), 'resolved: ' + imported[1]);

  assert.match(readFileSync(join(site, 'index.html'), 'utf8'), /demo\/auto\.html/);
});
