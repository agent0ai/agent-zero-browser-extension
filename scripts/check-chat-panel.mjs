// Isolated UI fixture only: never launches the user's Chrome profile or a native host.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep, extname } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.argv[2]);
const server = createServer(async (req, res) => {
  const file = resolve(root, `.${new URL(req.url, 'http://localhost').pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf' };
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const summary = { contextId: 'chat-one', label: 'Untitled task', kind: 'chat', status: 'idle', createdAtMs: 1, updatedAtMs: 2 };
    const task = { ...summary, contextId: 'task-one', label: 'Optional task', kind: 'task' };
    const projection = { contexts: [task, summary], selectedContextId: summary.contextId, suggestedContextId: summary.contextId,
      selected: { summary, events: [{ contextId: summary.contextId, sequence: 1, event: 'message', data: { role: 'assistant', text: 'Hello! I’m Agent Zero. What would you like to explore today?' } }],
        completionStatus: 'completed', lastSequence: 1, historyBefore: null, hasMoreHistory: false, messageQueue: [], approvals: [] } };
    const state = { ready: true, bridge: { phase: 'READY', loadGenerationId: 'load-one', connection: { state: 'ready', connectionId: 'connection-one', activationReady: true }, activeLeaseCount: 0 }, panel: {} };
    const listeners = new Set();
    window.chrome = { runtime: { connect: () => {
      setTimeout(() => listeners.forEach(fn => fn({ type: 'state', state })), 0);
      return { onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
        onDisconnect: { addListener() {}, removeListener() {} }, disconnect() {},
        postMessage: message => queueMicrotask(() => listeners.forEach(fn => fn({ type: 'ui_response', request_id: message.request_id, response: { ok: true, context: projection } }))) };
    }, openOptionsPage() {} } };
  });
  for (const width of [320, 420, 720]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto(`http://127.0.0.1:${server.address().port}/sidepanel.html`);
    const input = page.getByRole('textbox', { name: 'Message Agent Zero' });
    await input.waitFor();
    assert.equal(await page.getByText('Finished', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Queued messages', { exact: true }).count(), 0);
    assert.equal(await input.getAttribute('placeholder'), 'Message Agent Zero…');
    assert.deepEqual(await page.locator('optgroup').evaluateAll(nodes => nodes.map(node => node.label)), ['Chats', 'Tasks']);
    assert.equal(await page.locator('#chat-switcher option:checked').textContent(), 'Untitled chat');
    const geometry = await page.evaluate(() => {
      const field = document.querySelector('textarea').getBoundingClientRect();
      const button = document.querySelector('.composer button').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth,
        centerDifference: Math.abs(field.y + field.height / 2 - button.y - button.height / 2),
        footerBottom: document.querySelector('footer').getBoundingClientRect().bottom };
    });
    assert.equal(geometry.overflow, false);
    assert(geometry.centerDifference < 1);
    assert(geometry.footerBottom <= 760);
    await page.getByText('Browser access', { exact: false }).click();
    assert.equal(await page.getByText(/not all open Chrome tabs/).isVisible(), true);
    if (width === 420 && process.argv[3]) await page.screenshot({ path: resolve(process.argv[3]) });
    await input.fill('A longer message that should wrap naturally in the narrow panel. '.repeat(8));
    const height = await input.evaluate(node => node.getBoundingClientRect().height);
    assert(height > 44 && height <= 132);
  }
  console.log('Chat panel: 320/420/720px, scoped tabs, completed-chat layout and composer geometry passed.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
