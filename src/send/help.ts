// 読み上げタブの「＿側の準備」欄の部品。中身は送信先ごとに targets.ts で組み立てる。
type Inline = string | Node;

function line(parts: Inline[]): HTMLParagraphElement {
  const p = document.createElement('p');
  p.append(...parts);
  return p;
}

// 折りたたみ欄。title の後ろにバッジなどを並べられる
export function helpSection(title: Inline[], ...boxes: HTMLElement[]): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'send-help';
  const summary = document.createElement('summary');
  summary.append(...title);
  details.append(summary, ...boxes);
  return details;
}

// 説明の枠。lines は 1 要素 1 行。important は必須の手順用（赤）、それ以外は通常の説明（青）
export function helpBox(kind: 'info' | 'important', lines: Inline[][]): HTMLDivElement {
  const box = document.createElement('div');
  box.className = `help-box ${kind}`;
  box.append(...lines.map(line));
  return box;
}

export function badge(text: string): HTMLSpanElement {
  const e = document.createElement('span');
  e.className = 'help-badge';
  e.textContent = text;
  return e;
}

export function code(text: string): HTMLElement {
  const e = document.createElement('code');
  e.textContent = text;
  return e;
}

export function link(href: string, text = href): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

export function bold(text: string): HTMLElement {
  const e = document.createElement('strong');
  e.textContent = text;
  return e;
}
