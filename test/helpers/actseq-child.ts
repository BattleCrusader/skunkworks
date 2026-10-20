/**
 * One OS process, one activation — the restart half of E-31 item 5.
 *
 * A gate inside a single process cannot prove durability: the registry's in-memory counter is
 * already there, so the number would be right whether or not the row carried it. This child is
 * a **new process**: empty module cache, empty `SEQUENCES`, and the only place a number can
 * come from is `cms_plugin_installed.activation_seq`.
 *
 * Usage: node actseq-child.ts <dataDir> <tenant> <plugin>
 * Prints one JSON line: {"seq":<number the entry got>,"head":"<!--act:<n>-->"}
 * where `head` is what the package itself read out of its own `import.meta.url`.
 */
import { PluginRuntime } from '../../app/plugins/runtime.ts';

const [dataDir, tenant, plugin] = process.argv.slice(2) as [string, string, string];

const runtime = new PluginRuntime({ dataDir, emailMode: 'off' });
const result = await runtime.enable(tenant, plugin);
const head = await runtime.hooks.dispatchFilter<string>(
  'page.head',
  tenant,
  { tenant, path: '/' },
  '',
  runtime.registry.hooksFor(tenant, 'page.head'),
);
process.stdout.write(`${JSON.stringify({ seq: result.activationSeq, head })}\n`);
