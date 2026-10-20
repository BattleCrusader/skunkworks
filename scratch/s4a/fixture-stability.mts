/**
 * Per-fixture measurement for the S4a report: is the page byte-identical to what the gate
 * stores at pass 1? Same helper the gate uses (`twoPasses`), so the number is the gate's.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { canon } from '../../app/editor/canon.ts';
import { analyseBody } from '../../app/editor/model.ts';
import { loadRegistry } from '../../app/editor/registry.ts';
import { twoPasses } from '../../test/helpers/grapes.ts';
import { SCHEMA } from '../../test/helpers/fixture.ts';

const registry = loadRegistry(SCHEMA);
const SITE = '/Volumes/Backup/Development/skunkworks/test/fixtures/site';
const pages = readdirSync(SITE).filter((n) => n.endsWith('.html')).sort();

for (const page of pages) {
  const html = readFileSync(join(SITE, page), 'utf8');
  const { pass1 } = await twoPasses(registry, html);
  const first = await canon(analyseBody({ html: pass1, registry }).html);
  const stable = (await canon(html)) === first;
  const types = analyseBody({ html, registry }).components.map((c) => c.type).sort();
  console.log(
    `${page.padEnd(14)} ${String(Buffer.byteLength(html)).padStart(5)} B -> ${String(Buffer.byteLength(first)).padStart(5)} B  ` +
      `stable=${stable ? 'yes' : 'no '}  ${types.join('+')}`,
  );
}
