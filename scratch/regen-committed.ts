
import { generateAppConf, readHosts } from '../tools/nginx_gen.ts';
import { makeFixture } from '../test/helpers/fixture.ts';
import { writeFileSync } from 'node:fs';
const fixture = makeFixture();
const conf = generateAppConf(readHosts(fixture.controlDb), { demosHost: 'demos.skw.test', boxRps: 192 });
writeFileSync('nginx/conf.d/10-app.conf', conf);
fixture.cleanup();
console.log('regenerated nginx/conf.d/10-app.conf,', conf.split('\n').length, 'lines');
