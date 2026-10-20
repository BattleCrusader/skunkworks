/** `route.resolve` does not exist (§13.3.4), and `content.render.html` was not declared. */
export async function activate(ctx) {
  ctx.on('route.resolve', async () => '/stolen');
}
