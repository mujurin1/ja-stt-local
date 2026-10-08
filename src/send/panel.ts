// 送信タブ: 送信先ごとの ON/OFF・設定・テスト、送信ログ。
// 送信先固有の設定項目は TargetDescriptor.fields で宣言し、ここでは汎用に描画する。
import {SendManager} from './manager.ts';
import type {SendLogEntry} from './manager.ts';
import type {SenderId, SpeechSender} from './types.ts';

export interface FieldOption {
  value: string;
  label: string;
}

export interface Field {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: FieldOption[];
  // select の選択肢を送信先から取得する（VOICEVOX の話者一覧など）
  loadOptions?: (config: Record<string, unknown>) => Promise<FieldOption[]>;
  // 表示時に loadOptions を自動で呼ぶ（ブラウザ内で完結して失敗しにくいもの用）
  autoLoad?: boolean;
  hint?: string;
}

export interface TargetDescriptor {
  id: SenderId;
  label: string;
  description: string;
  // 「＿側の準備」欄を組み立てる（部品は help.ts）
  renderHelp(): HTMLElement;
  fields: Field[];
  defaultConfig: Record<string, unknown>;
  create(config: Record<string, unknown>): SpeechSender<unknown>;
}

interface SendSettings {
  includeFile: boolean;
  // セグメントボタンで表示中の送信先
  selected?: SenderId;
  enabled: Partial<Record<SenderId, boolean>>;
  configs: Partial<Record<SenderId, Record<string, unknown>>>;
}

const STORAGE_KEY = 'stt-send-v1';
const MAX_LOG = 50;

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function loadSendSettings(): SendSettings {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<SendSettings>;
    return {includeFile: s.includeFile ?? false, selected: s.selected, enabled: s.enabled ?? {}, configs: s.configs ?? {}};
  } catch {
    return {includeFile: false, enabled: {}, configs: {}};
  }
}

export class SendPanel {
  root: HTMLElement;
  tabState: HTMLElement;
  targets: TargetDescriptor[];
  settings = loadSendSettings();
  manager: SendManager;
  logList = el('ol', 'send-log');

  constructor(root: HTMLElement, tabState: HTMLElement, targets: TargetDescriptor[]) {
    this.root = root;
    this.tabState = tabState;
    this.targets = targets;
    this.manager = new SendManager((entry) => this.appendLog(entry));
    for (const t of targets) {
      this.manager.register(t.create(this.configOf(t)));
      this.manager.setEnabled(t.id, this.settings.enabled[t.id] ?? false);
    }
    this.render();
  }

  // 確定文を受け取る。fromFile はファイル文字起こし由来かどうか
  dispatch(text: string, fromFile: boolean): void {
    if (fromFile && !this.settings.includeFile) return;
    this.manager.dispatch(text);
  }

  private configOf(t: TargetDescriptor): Record<string, unknown> {
    return {...t.defaultConfig, ...this.settings.configs[t.id]};
  }

  private save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    this.updateTabState();
  }

  private updateTabState(): void {
    const on = this.targets.filter((t) => this.settings.enabled[t.id]).map((t) => t.label);
    this.tabState.textContent = on.length ? `● ${on.join('・')}` : '';
    this.tabState.className = on.length ? 'tab-state on' : 'tab-state';
  }

  private render(): void {
    const intro = el('p', 'note',
        '確定した文を読み上げます。ブラウザ内蔵の声か、この PC で動いている読み上げアプリ（ブラウザから直接 localhost に送信）を使えます');
    const includeFile = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = this.settings.includeFile;
    cb.addEventListener('change', () => {
      this.settings.includeFile = cb.checked;
      this.save();
    });
    includeFile.append(cb, ' ファイル文字起こしの結果も送る');

    const logHead = el('div', 'send-log-head');
    const clear = el('button', 'link', 'ログを消去');
    clear.addEventListener('click', () => this.logList.replaceChildren());
    logHead.append(el('h3', '', '送信ログ'), clear);

    // 送信先はセグメントボタンで切り替え、1 つずつ表示する
    const seg = el('div', 'segmented');
    seg.setAttribute('role', 'tablist');
    const cards = this.targets.map((t) => this.renderTarget(t));
    const buttons = this.targets.map((t) => {
      const b = el('button', this.settings.enabled[t.id] ? 'seg-btn on' : 'seg-btn');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.target = t.id;
      b.append(el('span', 'seg-dot'), t.label);
      b.addEventListener('click', () => show(t.id));
      return b;
    });
    const show = (id: SenderId) => {
      this.settings.selected = id;
      buttons.forEach((b, i) => b.setAttribute('aria-selected', String(this.targets[i]!.id === id)));
      cards.forEach((c, i) => (c.hidden = this.targets[i]!.id !== id));
      this.save();
    };
    seg.append(...buttons);
    show(this.targets.some((t) => t.id === this.settings.selected) ? this.settings.selected! : this.targets[0]!.id);

    this.root.replaceChildren(intro, seg, ...cards, includeFile, logHead, this.logList);
    this.updateTabState();
  }

  private renderTarget(t: TargetDescriptor): HTMLElement {
    const card = el('section', 'send-target');
    const head = el('label', 'send-target-head');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = this.settings.enabled[t.id] ?? false;
    toggle.addEventListener('change', () => {
      this.settings.enabled[t.id] = toggle.checked;
      this.manager.setEnabled(t.id, toggle.checked);
      card.classList.toggle('on', toggle.checked);
      this.root.querySelector(`.seg-btn[data-target=${t.id}]`)?.classList.toggle('on', toggle.checked);
      this.save();
    });
    card.classList.toggle('on', toggle.checked);
    head.append(toggle, el('span', 'send-target-name', `${t.label} を使う`), el('span', 'note', t.description));

    const fields = el('div', 'send-fields');
    for (const f of t.fields) fields.append(this.renderField(t, f));

    const actions = el('div', 'row');
    const test = el('button', '', 'テスト送信');
    test.addEventListener('click', () => this.manager.test(t.id));
    actions.append(test);

    card.append(head, fields, actions, t.renderHelp());
    return card;
  }

  private renderField(t: TargetDescriptor, f: Field): HTMLElement {
    const wrap = el('label', 'send-field');
    wrap.append(el('span', '', f.label));
    const current = () => this.configOf(t)[f.key];
    const update = (value: unknown) => {
      const config = {...this.configOf(t), [f.key]: value};
      this.settings.configs[t.id] = config;
      this.manager.register(t.create(config));
      this.save();
    };

    if (f.type === 'select') {
      const sel = el('select');
      const fill = (opts: FieldOption[]) => {
        const v = String(current() ?? '');
        sel.replaceChildren(...opts.map((o) => new Option(o.label, o.value)));
        if (!opts.some((o) => o.value === v)) sel.append(new Option(v, v));
        sel.value = v;
      };
      fill(f.options ?? []);
      sel.addEventListener('change', () => update(isNaN(Number(sel.value)) ? sel.value : Number(sel.value)));
      wrap.append(sel);
      if (f.loadOptions) {
        const reload = el('button', 'link', '一覧を取得');
        reload.type = 'button';
        reload.addEventListener('click', async (e) => {
          e.preventDefault();
          try {
            fill(await f.loadOptions!(this.configOf(t)));
          } catch (err) {
            alert(err instanceof Error ? err.message : String(err));
          }
        });
        wrap.append(reload);
        if (f.autoLoad) void f.loadOptions(this.configOf(t)).then(fill).catch(() => {});
      }
    } else {
      const input = el('input');
      input.type = f.type;
      if (f.min !== undefined) input.min = String(f.min);
      if (f.max !== undefined) input.max = String(f.max);
      if (f.step !== undefined) input.step = String(f.step);
      input.value = String(current() ?? '');
      input.addEventListener('change', () => update(f.type === 'number' ? Number(input.value) : input.value));
      wrap.append(input);
    }
    if (f.hint) wrap.append(el('span', 'hint', f.hint));
    return wrap;
  }

  private appendLog(e: SendLogEntry): void {
    const li = el('li', e.ok ? 'ok' : 'err');
    const time = e.time.toLocaleTimeString('ja-JP', {hour12: false});
    li.append(el('span', 'ts', time), el('span', 'target', e.target), el('span', 'text', e.text));
    if (e.detail) li.append(el('span', 'detail', e.detail));
    this.logList.prepend(li);
    while (this.logList.children.length > MAX_LOG) this.logList.lastElementChild?.remove();
    if (!e.ok) {
      this.tabState.textContent = '● エラー';
      this.tabState.className = 'tab-state err';
    }
  }
}
