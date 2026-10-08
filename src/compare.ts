// 比較タブ: メインのモデルと、ここで追加したモデルを同時に動かして列で並べる。
// メインの列は main.ts から結果を流し込んでもらい、追加ぶんは列ごとに自前のエンジンを持つ。
// 追加ぶんはタブを閉じても動き続け、× で外すまで録音のたびに一緒に認識する。
import {AsrClient} from './engine/asr-client.ts';
import {NativeAsr} from './engine/native-asr.ts';
import {MODELS, modelTotalBytes} from './shared/models.ts';
import type {AsrEvent, AsrSettings, ModelSpec, Segment} from './shared/protocol.ts';

export interface CompareHooks {
  vendorBase: string;
  mainModel(): ModelSpec;
  asrSettings(): AsrSettings;
  // ブラウザ標準を追加できるか（端末内認識の API があるか）
  nativeSelectable(): boolean;
  // ブラウザ標準の言語パックを用意する。使えるなら true
  ensureNative(): Promise<boolean>;
  // 追加・削除のあと（録音中にマイク取り込みが必要になった場合などに使う）
  onChanged(): void;
}

interface Column {
  spec: ModelSpec;
  root: HTMLElement;
  status: HTMLElement;
  list: HTMLOListElement;
  partial: HTMLParagraphElement;
  body: HTMLElement;
}

interface Extra extends Column {
  asr: AsrClient | null;
  native: NativeAsr | null;
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

export class ComparePanel {
  hooks: CompareHooks;
  addSelect: HTMLSelectElement;
  totalInfo: HTMLElement;
  grid: HTMLElement;
  main: Column;
  extras: Extra[] = [];
  running = false;

  constructor(root: HTMLElement, hooks: CompareHooks) {
    this.hooks = hooks;
    this.addSelect = el('select', 'compare-add');
    this.addSelect.addEventListener('change', () => {
      const spec = MODELS.find((m) => m.id === this.addSelect.value);
      this.addSelect.value = '';
      if (spec) this.add(spec);
    });
    this.totalInfo = el('span', 'note');
    const clearBtn = el('button', 'danger', 'クリア');
    clearBtn.addEventListener('click', () => this.clear());
    const toolbar = el('div', 'toolbar');
    toolbar.append(this.addSelect, this.totalInfo, el('span', 'spacer'), clearBtn);

    this.grid = el('div', 'compare-grid');
    this.main = this.makeColumn(hooks.mainModel(), null);
    this.grid.append(this.main.root);
    root.replaceChildren(
        toolbar, el('p', 'note', '★ がメイン（文字起こしタブ・読み上げに使う）。モデルを増やすほど CPU とメモリを使います'),
        this.grid);
    this.renderToolbar();
  }

  // 録音中にマイク取り込みが必要か（ダウンロード型のモデルが追加されているか）
  needsCapture(): boolean {
    return this.extras.some((x) => x.asr);
  }

  // ---- メイン列（main.ts から呼ぶ） ----

  mainChanged(): void {
    const spec = this.hooks.mainModel();
    const dup = this.extras.find((x) => x.spec.id === spec.id);
    if (dup) this.remove(dup);
    const fresh = this.makeColumn(spec, null);
    fresh.list.append(...this.main.list.childNodes);
    this.main.root.replaceWith(fresh.root);
    this.main = fresh;
    this.renderToolbar();
  }

  mainPartial(text: string): void {
    this.setPartial(this.main, text);
  }

  mainFinal(seg: Segment): void {
    this.appendFinal(this.main, seg.text);
  }

  mainStatus(text: string): void {
    this.main.status.textContent = text;
  }

  // ---- 録音 ----

  // マイク音声（ノイズ除去後）を追加ぶんに配る。worker へは transfer で渡すので列ごとにコピーする
  push(samples: Float32Array): void {
    for (const x of this.extras) x.asr?.push(samples.slice());
  }

  start(): void {
    this.running = true;
    for (const x of this.extras) x.native?.start();
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.extras.map((x) => x.native?.stop() ?? x.asr?.flush()));
  }

  updateSettings(settings: AsrSettings): void {
    for (const x of this.extras) x.asr?.updateSettings(settings);
  }

  clear(): void {
    for (const c of [this.main, ...this.extras]) {
      c.list.replaceChildren();
      c.partial.textContent = '';
    }
  }

  // ---- 列の追加・削除 ----

  private add(spec: ModelSpec): void {
    const col = this.makeColumn(spec, () => this.remove(x));
    const x: Extra = {...col, asr: null, native: null};
    this.extras.push(x);
    this.grid.append(x.root);
    this.renderToolbar();

    if (spec.kind === 'native') {
      x.native = new NativeAsr({
        onPartial: (text) => this.setPartial(x, text),
        onFinal: (seg) => this.appendFinal(x, seg.text),
        onFatal: (message) => {
          x.status.textContent = `停止: ${message}`;
        },
      });
      x.status.textContent = '言語パックを確認中…';
      void this.hooks.ensureNative().then((ok) => {
        if (!this.extras.includes(x)) return;
        x.status.textContent = ok ? '' : '言語パックを用意できません';
        if (ok && this.running) x.native?.start();
      });
    } else {
      x.asr = new AsrClient(this.hooks.vendorBase, {
        onEvent: (ev) => this.handleEvent(x, ev),
        onState: (state, detail) => {
          const labels = {
            loading: '読み込み中…',
            ready: '準備完了',
            restarting: `自動復帰中: ${detail ?? ''}`,
            failed: `停止: ${detail ?? ''}`,
          };
          x.status.textContent = labels[state];
        },
      });
      x.asr.load(spec, this.hooks.asrSettings());
    }
    this.hooks.onChanged();
  }

  private remove(x: Extra): void {
    x.asr?.dispose();
    if (x.native) void x.native.stop();
    this.extras = this.extras.filter((e) => e !== x);
    x.root.remove();
    this.renderToolbar();
    this.hooks.onChanged();
  }

  private handleEvent(x: Extra, ev: AsrEvent): void {
    switch (ev.type) {
      case 'progress':
        x.status.textContent =
            `取得中 ${ev.total > 0 ? Math.floor(ev.loaded / ev.total * 100) : 0}%`;
        break;
      case 'partial':
        this.setPartial(x, ev.text);
        break;
      case 'final':
        this.setPartial(x, '');
        if (ev.segment.text) this.appendFinal(x, ev.segment.text);
        break;
      case 'stats':
        if (this.running) x.status.textContent = `遅れ ${(ev.queueMs / 1000).toFixed(1)}s`;
        break;
      default:
        break;
    }
  }

  // ---- 表示 ----

  private renderToolbar(): void {
    const used = new Set([this.main.spec.id, ...this.extras.map((x) => x.spec.id)]);
    const options = [new Option('+ 比較に追加…', '')];
    for (const m of MODELS) {
      if (used.has(m.id)) continue;
      if (m.kind === 'native' && !this.hooks.nativeSelectable()) continue;
      const size = m.kind === 'native' ? '' : `（${mb(modelTotalBytes(m))}MB）`;
      options.push(new Option(`${m.label}${size}`, m.id));
    }
    this.addSelect.replaceChildren(...options);
    this.addSelect.disabled = options.length === 1;

    const total = [this.main, ...this.extras].reduce((s, c) => s + modelTotalBytes(c.spec), 0);
    this.totalInfo.textContent = this.extras.length > 0 ?
        `${this.extras.length + 1} モデル・合計 約${mb(total)}MB` :
        '';
  }

  private makeColumn(spec: ModelSpec, onRemove: (() => void) | null): Column {
    const root = el('section', 'compare-col');
    const head = el('div', 'compare-head');
    const name = el('span', 'name', onRemove ? spec.label : `${spec.label} ★`);
    head.append(name);
    if (onRemove) {
      const close = el('button', 'icon', '×');
      close.title = '比較から外す';
      close.addEventListener('click', onRemove);
      head.append(close);
    }
    const status = el('div', 'compare-status');
    const body = el('div', 'compare-body');
    const list = el('ol');
    const partial = el('p', 'partial');
    body.append(list, partial);
    root.append(head, status, body);
    return {spec, root, status, list, partial, body};
  }

  private stick(c: Column): () => void {
    const b = c.body;
    const near = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
    return () => {
      if (near) b.scrollTop = b.scrollHeight;
    };
  }

  private setPartial(c: Column, text: string): void {
    const done = this.stick(c);
    c.partial.textContent = text;
    done();
  }

  private appendFinal(c: Column, text: string): void {
    const done = this.stick(c);
    c.list.append(el('li', '', text));
    done();
  }
}
