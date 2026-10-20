/** Child process for the concurrency probe: publishes the same key in a loop. */
import { publishSource, type SourceInput } from '../../app/sources/publish.ts';

const file = process.argv[2] as string;
const rounds = Number(process.argv[3] ?? 20);
const actor = { userId: 1, label: 'racer@acme.test' };

const A: SourceInput = {
  key: 'race',
  kind: 'query',
  spec: {
    table: 'u_posts',
    columns: ['title'],
    where: [{ col: 'status', op: '=', param: 'status' }],
    order: [{ col: 'published_at', dir: 'desc' }],
    limit_default: 3,
    limit_max: 50,
  },
  params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
  isPublic: true,
  ttlS: 60,
};
const B: SourceInput = { ...A, spec: { ...(A.spec as object), columns: ['title', 'slug'] } as SourceInput['spec'] };

for (let i = 0; i < rounds; i += 1) {
  publishSource(file, i % 2 === 0 ? A : B, actor, { measureRuns: 20 });
}
process.stdout.write(`child published ${rounds}\n`);
