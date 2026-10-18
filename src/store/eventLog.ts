// The numbered update events behind get_updates and `imessage watch`, held in memory. Both stores keep one: the mock
// adds events as its fake data changes, the live store as polling finds changes in chat.db.

import { EventEmitter } from 'node:events';
import type { UpdateEvent } from './types.js';

/** What an event says besides its type, message and chat. */
export type EventExtra = Pick<UpdateEvent, 'actorId' | 'reaction' | 'previousText'>;

/** Keeps the latest 4,000 to 5,000 events; a cursor older than the oldest one held has expired. */
export class EventLog {
  private emitter = new EventEmitter();
  private events: UpdateEvent[] = [];
  private seq = 0;

  constructor(private now: () => number) {
    this.emitter.setMaxListeners(200);
  }

  emit(type: UpdateEvent['type'], messageId: string, chatId: string, extra: EventExtra = {}): void {
    const ev: UpdateEvent = { seq: ++this.seq, type, messageId, chatId, at: this.now(), ...extra };
    this.events.push(ev);
    if (this.events.length > 5000) this.events.splice(0, 1000);
    this.emitter.emit('update', ev);
  }

  updatesSince(seq: number): UpdateEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  latestSeq(): number {
    return this.seq;
  }

  /** The oldest seq still held (latestSeq() + 1 when none are held). */
  oldestSeq(): number {
    return this.events[0]?.seq ?? this.seq + 1;
  }

  /** Resolves on the next event after afterSeq, or after timeoutMs. */
  waitForUpdate(afterSeq: number, timeoutMs: number): Promise<void> {
    if (this.seq > afterSeq || timeoutMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.emitter.off('update', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.emitter.on('update', done);
    });
  }
}
