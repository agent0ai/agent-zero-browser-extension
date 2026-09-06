import { describe, expect, it, vi } from "vitest";
import { TabMentions } from "./tab-mentions";

const tab = { id: 10, title: 'A [tab]', url: 'https://example.com/page?q=chosen#section', incognito: false };
describe('explicit tab references', () => {
  it('lists only safe web tabs with opaque handles, and selects a link without control', async () => {
    const query = vi.fn(async () => [tab, { ...tab, id: 11, url: 'chrome://settings' },
      { ...tab, id: 12, incognito: true }, { ...tab, id: 13, url: 'https://user:secret@example.com' },
      { ...tab, id: 14, pendingUrl: 'https://example.org' }]);
    const get = vi.fn(async () => tab);
    const mentions = new TabMentions({ query, get }, () => 1, () => 'opaque');
    expect(query).not.toHaveBeenCalled();
    const choices = await mentions.list('selected-panel-chat', () => true);
    expect(choices).toEqual([{ id: 'tab-reference:opaque', title: tab.title, url: tab.url }]);
    await expect(mentions.select('different-panel', choices[0].id, () => true)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(await mentions.select('selected-panel-chat', choices[0].id, () => true)).toBe('@[A \\[tab\\]](https://example.com/page?q=chosen#section)');
    expect(get).toHaveBeenCalledWith(10);
    await expect(mentions.select('selected-panel-chat', choices[0].id, () => true)).rejects.toThrow();
  });
  it('rejects changed, expired or disconnected selections', async () => {
    let now = 1;
    const get = vi.fn(async () => ({ ...tab, url: 'https://example.org/changed' }));
    const mentions = new TabMentions({ query: async () => [tab], get }, () => now, () => 'opaque');
    await mentions.list('scope', () => true);
    await expect(mentions.select('scope', 'tab-reference:opaque', () => true)).rejects.toThrow('TAB_CHANGED');
    get.mockResolvedValue(tab);
    await expect(mentions.select('scope', 'tab-reference:opaque', () => false)).rejects.toThrow();
    now = 120_002;
    await expect(mentions.select('scope', 'tab-reference:opaque', () => true)).rejects.toThrow();
  });
  it('rechecks authority after tab reads and never exposes a provider tab ID', async () => {
    let active = true;
    const mentions = new TabMentions({ query: async () => [tab], get: async () => { active = false; return tab; } });
    const choices = await mentions.list('scope', () => active);
    expect(Object.keys(choices[0]).sort()).toEqual(['id', 'title', 'url']);
    await expect(mentions.select('scope', choices[0].id, () => active)).rejects.toThrow();
  });
});
