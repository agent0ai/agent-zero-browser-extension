export interface TabMentionChoice { id: string; title: string; url: string }
type TabInfo = Pick<chrome.tabs.Tab, "id" | "url" | "title" | "incognito" | "pendingUrl">;

function visibleTab(tab: TabInfo): Omit<TabMentionChoice, "id"> | null {
  if (tab.incognito || !Number.isInteger(tab.id) || Number(tab.id) < 0 || !tab.url || tab.pendingUrl || tab.url.length > 2048) return null;
  try {
    const url = new URL(tab.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return { title: (tab.title || url.hostname).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160), url: url.href };
  } catch { return null; }
}

/** Explicit user-selected link metadata only. No leases, page reads or tab mutation. */
export class TabMentions {
  private catalogs = new Map<string, { expires: number; choices: Map<string, TabMentionChoice & { tabId: number }> }>();
  constructor(private readonly tabs: { query: () => Promise<TabInfo[]>; get: (id: number) => Promise<TabInfo> },
    private readonly now = Date.now, private readonly uuid: () => string = () => crypto.randomUUID()) {}

  async list(scope: string, current: () => boolean): Promise<TabMentionChoice[]> {
    const tabs = await this.tabs.query();
    if (!current()) throw new Error("TAB_PICKER_EXPIRED");
    for (const [key, catalog] of this.catalogs) if (catalog.expires <= this.now()) this.catalogs.delete(key);
    this.catalogs.delete(scope);
    while (this.catalogs.size >= 8) this.catalogs.delete(this.catalogs.keys().next().value!);
    const choices = new Map<string, TabMentionChoice & { tabId: number }>();
    for (const tab of tabs) {
      const value = visibleTab(tab);
      if (!value) continue;
      const id = `tab-reference:${this.uuid()}`;
      choices.set(id, { ...value, id, tabId: tab.id! });
      if (choices.size === 200) break;
    }
    this.catalogs.set(scope, { expires: this.now() + 120_000, choices });
    return [...choices.values()].map(({ tabId: _private, ...value }) => value);
  }

  async select(scope: string, id: string, current: () => boolean): Promise<string> {
    const catalog = this.catalogs.get(scope);
    const choice = catalog?.choices.get(id);
    if (!catalog || !choice || catalog.expires <= this.now() || !current()) throw new Error("TAB_PICKER_EXPIRED");
    const live = visibleTab(await this.tabs.get(choice.tabId));
    if (!current() || this.catalogs.get(scope) !== catalog || catalog.expires <= this.now()
      || !live || live.url !== choice.url || live.title !== choice.title) throw new Error("TAB_CHANGED");
    this.catalogs.delete(scope);
    // Encode Markdown delimiters in the URL and escape the untrusted title.
    const title = choice.title.replace(/[\\[\]`*_<>]/g, "\\$&");
    const url = choice.url.replace(/[()<>\\]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    return `@[${title}](${url})`;
  }

  clear(): void { this.catalogs.clear(); }
}
