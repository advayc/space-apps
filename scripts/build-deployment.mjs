import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

// This commit contains every binary named in the current catalog.
const dataRevision = '8ed3c3f31ded0cb88c8e01027d6758e093ec9d3e';
const expectedFilesHash = '81e960be2b527b763e19e0f3f94e0c4290053ff462903bb7601d94122b7bfd28';
const catalog = JSON.parse(await readFile('dist/assets/catalog.json', 'utf8'));
const files = new Set();
for (const layer of Object.values(catalog)) {
  files.add(layer.file);
  for (const period of Object.values(layer.periods)) files.add(period.file);
  if (layer.climatology) files.add(layer.climatology.file);
}
const filesHash = createHash('sha256').update([...files].sort().join('\n')).digest('hex');
if (filesHash !== expectedFilesHash) {
  throw new Error('Dataset files changed. Publish them to GitHub and update dataRevision and expectedFilesHash before deploying.');
}
const output = 'deployment-output';
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
await cp('dist', output, {
  recursive: true,
  filter: source => !source.endsWith('.bin') && path.basename(source) !== '.DS_Store',
});
const dataBase = `https://raw.githubusercontent.com/advayc/space-apps/${dataRevision}/dist/assets/`;
await writeFile(path.join(output, 'asset-base.js'), `window.ATLAS_DATA_BASE = ${JSON.stringify(dataBase)};\n`);
