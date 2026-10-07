// 確定文を有効な送信先へ配る。送信先ごとに直列化して順序を保ち、結果をログとして通知する。
import type {SenderId, SendResult, SpeechSender} from './types.ts';

export interface SendLogEntry {
  time: Date;
  target: string;
  text: string;
  ok: boolean;
  detail?: string;
}

// 送れなかった文が溜まり続けないよう、送信先ごとの待ち行列には上限を設ける
const MAX_PENDING = 20;

export class SendManager {
  senders = new Map<SenderId, SpeechSender<unknown>>();
  enabled = new Set<SenderId>();
  chains = new Map<SenderId, Promise<void>>();
  pending = new Map<SenderId, number>();
  onLog: (entry: SendLogEntry) => void;

  constructor(onLog: (entry: SendLogEntry) => void) {
    this.onLog = onLog;
  }

  register(sender: SpeechSender<unknown>): void {
    this.senders.get(sender.id)?.dispose();
    this.senders.set(sender.id, sender);
  }

  setEnabled(id: SenderId, enabled: boolean): void {
    if (enabled) this.enabled.add(id);
    else this.enabled.delete(id);
  }

  dispatch(text: string): void {
    const t = text.trim();
    if (!t) return;
    for (const id of this.enabled) {
      const sender = this.senders.get(id);
      if (sender) this.enqueue(sender, t, () => sender.send(t));
    }
  }

  test(id: SenderId): void {
    const sender = this.senders.get(id);
    if (sender) this.enqueue(sender, '（接続テスト）', () => sender.test());
  }

  private enqueue(sender: SpeechSender<unknown>, text: string, run: () => Promise<SendResult>): void {
    const n = this.pending.get(sender.id) ?? 0;
    if (n >= MAX_PENDING) {
      this.onLog({time: new Date(), target: sender.label, text, ok: false, detail: '送信待ちが多すぎるため破棄'});
      return;
    }
    this.pending.set(sender.id, n + 1);
    const prev = this.chains.get(sender.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        const r = await run();
        this.onLog({
          time: new Date(),
          target: sender.label,
          text,
          ok: true,
          detail: r.detail ?? (r.confirmed ? undefined : '送信済み（応答は確認できません）'),
        });
      } catch (e) {
        this.onLog({
          time: new Date(),
          target: sender.label,
          text,
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        });
      } finally {
        this.pending.set(sender.id, (this.pending.get(sender.id) ?? 1) - 1);
      }
    });
    this.chains.set(sender.id, next);
  }
}
