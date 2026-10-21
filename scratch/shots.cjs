
const { chromium } = require('playwright');
(async () => {
  const files = ['01-ops-console.html','02-quiet-editorial.html','03-guided-cards.html'];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  for (const f of files) {
    await page.goto('file://' + process.cwd() + '/docs/design/admin/' + f, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const out = '/tmp/shot-' + f.replace('.html','') + '.png';
    await page.screenshot({ path: out, fullPage: true });
    const h = await page.evaluate(() => document.body.scrollHeight);
    console.log(f, '->', out, 'height', h);
  }
  await browser.close();
})();
