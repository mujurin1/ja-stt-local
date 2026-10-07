// モデルタブ: 1 モデル 1 行の一覧（行クリックで選択）＋選択中モデルの詳細。
// 行ごとに事前ダウンロード・キャッシュ削除ができる。
import {deleteModel, downloadModel, modelCacheStatus} from './shared/model-cache.ts';
import type {CacheStatus} from './shared/model-cache.ts';
import {MODELS, modelTotalBytes} from './shared/models.ts';
import type {ModelSpec} from './shared/protocol.ts';

export interface ModelPanelHooks {
  currentId(): string;
  onSelect(spec: ModelSpec): void;
  onCacheChanged(): void;
}

interface Download {
  ctrl: AbortController;
  loaded: number;
  total: number;
}

const COMMERCIAL = {
  ok: {label: '商用可', cls: 'ok'},
  check: {label: '商用は要確認', cls: 'warn'},
  ng: {label: '非商用のみ', cls: 'ng'},
} as const;

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// 行クリック（=選択）と区別するため、ボタンのクリックは行に伝えない
function button(text: string, cls: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export class ModelPanel {
  list: HTMLUListElement;
  detail: HTMLElement;
  hooks: ModelPanelHooks;
  status = new Map<string, CacheStatus>();
  downloads = new Map<string, Download>();

  constructor(list: HTMLUListElement, detail: HTMLElement, hooks: ModelPanelHooks) {
    this.list = list;
    this.detail = detail;
    this.hooks = hooks;
  }

  async refresh(): Promise<void> {
    const results = await Promise.all(MODELS.map((m) => modelCacheStatus(m)));
    MODELS.forEach((m, i) => this.status.set(m.id, results[i] ?? 'none'));
    this.render();
  }

  statusOf(id: string): CacheStatus {
    return this.status.get(id) ?? 'none';
  }

  render(): void {
    const currentId = this.hooks.currentId();
    this.list.replaceChildren(...MODELS.map((m) => this.renderRow(m, m.id === currentId)));
    this.renderDetail(MODELS.find((m) => m.id === currentId) ?? MODELS[0]!);
  }

  private renderRow(m: ModelSpec, active: boolean): HTMLLIElement {
    const li = el('li', active ? 'model-row active' : 'model-row');
    li.tabIndex = 0;
    li.setAttribute('role', 'radio');
    li.setAttribute('aria-checked', String(active));
    li.addEventListener('click', () => this.hooks.onSelect(m));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.hooks.onSelect(m);
      }
    });

    const name = el('div', 'name');
    const tags = el('div', 'tags');
    if (m.tag) tags.append(el('span', 'tag', m.tag));
    if (m.commercial === 'ng') tags.append(el('span', 'tag ng', '非商用'));
    const texts = el('div', 'texts');
    texts.append(el('span', 'label', m.label), tags);
    name.append(el('span', 'radio'), texts);
    li.append(name, el('span', 'size', `${mb(modelTotalBytes(m))}MB`), this.renderAction(m));
    return li;
  }

  private renderAction(m: ModelSpec): HTMLElement {
    const box = el('div', 'action');
    const dl = this.downloads.get(m.id);
    if (dl) {
      const pct = dl.total ? Math.floor(dl.loaded / dl.total * 100) : 0;
      const bar = el('div', 'bar mini');
      const fill = el('div');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      box.append(bar, el('span', 'pct', `${pct}%`),
                 button('×', 'icon', 'ダウンロードを中止', () => dl.ctrl.abort()));
      return box;
    }
    const status = this.statusOf(m.id);
    if (status === 'cached') {
      box.append(button('削除', 'small danger', 'このモデルのキャッシュを削除', () => void this.remove(m)));
    } else {
      box.append(button(status === 'partial' ? '続きを取得' : '取得', 'small', 'ダウンロードして保存',
                        () => void this.download(m)));
    }
    return box;
  }

  private renderDetail(m: ModelSpec): void {
    const c = COMMERCIAL[m.commercial];
    const lic = el('p', 'license');
    lic.append(`ライセンス: ${m.license} `, el('span', `badge ${c.cls}`, c.label));
    this.detail.replaceChildren(el('p', 'detail-name', m.label), el('p', '', m.note), lic);
  }

  async download(m: ModelSpec): Promise<void> {
    if (this.downloads.has(m.id)) return;
    void navigator.storage?.persist?.();
    const dl: Download = {ctrl: new AbortController(), loaded: 0, total: modelTotalBytes(m)};
    this.downloads.set(m.id, dl);
    this.render();
    let lastRender = 0;
    try {
      await downloadModel(m, (loaded, total) => {
        dl.loaded = loaded;
        dl.total = total;
        const now = performance.now();
        if (now - lastRender > 250) {
          lastRender = now;
          this.render();
        }
      }, dl.ctrl.signal);
    } catch (e) {
      if (!dl.ctrl.signal.aborted) alert(`ダウンロードに失敗しました: ${String(e)}`);
    } finally {
      this.downloads.delete(m.id);
      await this.refresh();
      this.hooks.onCacheChanged();
    }
  }

  async remove(m: ModelSpec): Promise<void> {
    const inUse = m.id === this.hooks.currentId();
    const msg = inUse ?
        `${m.label} を削除しますか？\n（使用中のモデルはメモリ上に残るので、このまま使えます。次回起動時に再ダウンロードになります）` :
        `${m.label} を削除しますか？`;
    if (!confirm(msg)) return;
    await deleteModel(m);
    await this.refresh();
    this.hooks.onCacheChanged();
  }
}
