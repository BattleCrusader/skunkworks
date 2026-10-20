/**
 * Two broken filters, and no third: a throw and a wrong type. `mode` is read from the module URL
 * so one package can be installed once and behave differently in two gates? No — it is fixed:
 * the throw comes first, the wrong type second, and the gate counts both.
 */
export async function activate(ctx) {
  ctx.on('content.render.html', async () => {
    throw new Error('thrower: this filter always throws');
  });
  ctx.on('page.head', async () => 42);
}
