import { synthesize } from "./tts.js";
import { dbGet, dbPut } from "./db.js";

export class Player {
  constructor(audio, callbacks) {
    this.audio = audio;
    this.cb = callbacks;
    this.book = null;
    this.chapters = [];
    this.ch = 0;
    this.ck = 0;
    this.rate = 1.0;
    this.speaker = 3;
    this.apiKey = "";
    this.playing = false;
    this.loadSeq = 0;
    this.urls = new Map();
    this.prefetching = false;

    audio.addEventListener("ended", () => {
      if (this.playing) this.advance(1);
    });
    audio.addEventListener("error", () => {
      if (this.playing) {
        this.playing = false;
        this.cb.onPlayState(false);
        this.cb.onError(new Error("音声の再生に失敗しました"));
      }
    });
  }

  setBook(book, chapters) {
    this.book = book;
    this.chapters = chapters;
    const pos = book.position || { chapter: 0, chunk: 0 };
    this.ch = Math.min(pos.chapter, chapters.length - 1);
    this.ck = Math.min(pos.chunk, chapters[this.ch].chunks.length - 1);
    this.audio.removeAttribute("src");
    this.playing = false;
  }

  cacheKey(ch, ck) {
    return ch + ":" + ck + ":" + this.speaker;
  }

  async getUrl(ch, ck) {
    const k = this.cacheKey(ch, ck);
    if (this.urls.has(k)) return this.urls.get(k);
    const idbKey = [this.book.id, ch, ck, this.speaker];
    let rec = await dbGet("audio", idbKey);
    if (!rec) {
      const blob = await synthesize(this.chapters[ch].chunks[ck], this.speaker, this.apiKey);
      rec = { bookId: this.book.id, chapter: ch, chunk: ck, speaker: this.speaker, blob };
      await dbPut("audio", rec);
    }
    const url = URL.createObjectURL(rec.blob);
    this.urls.set(k, url);
    if (this.urls.size > 30) {
      const oldest = this.urls.keys().next().value;
      URL.revokeObjectURL(this.urls.get(oldest));
      this.urls.delete(oldest);
    }
    return url;
  }

  async playAt(ch, ck) {
    if (!this.chapters.length) return;
    ch = Math.max(0, Math.min(ch, this.chapters.length - 1));
    ck = Math.max(0, Math.min(ck, this.chapters[ch].chunks.length - 1));
    this.ch = ch;
    this.ck = ck;
    this.playing = true;
    const seq = ++this.loadSeq;
    this.cb.onChunk(ch, ck);
    this.cb.onPlayState(true, true);
    try {
      const url = await this.getUrl(ch, ck);
      if (seq !== this.loadSeq) return;
      this.audio.src = url;
      this.audio.playbackRate = this.rate;
      await this.audio.play();
      this.audio.playbackRate = this.rate;
      if (seq !== this.loadSeq) return;
      this.cb.onPlayState(true, false);
      this.savePosition();
      this.prefetch();
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.playing = false;
      this.cb.onPlayState(false, false);
      this.cb.onError(e);
    }
  }

  nextPos(ch, ck) {
    ck++;
    if (ck >= this.chapters[ch].chunks.length) {
      ch++;
      ck = 0;
    }
    return ch < this.chapters.length ? [ch, ck] : null;
  }

  advance(dir) {
    if (dir > 0) {
      const pos = this.nextPos(this.ch, this.ck);
      if (!pos) {
        this.playing = false;
        this.cb.onPlayState(false, false);
        if (this.cb.onBookEnd) this.cb.onBookEnd();
        return;
      }
      this.playAt(pos[0], pos[1]);
    } else {
      let ch = this.ch;
      let ck = this.ck - 1;
      if (ck < 0) {
        if (ch === 0) ck = 0;
        else { ch--; ck = this.chapters[ch].chunks.length - 1; }
      }
      this.playAt(ch, ck);
    }
  }

  pause() {
    this.playing = false;
    this.loadSeq++;
    this.audio.pause();
    this.cb.onPlayState(false, false);
    this.savePosition();
  }

  resume() {
    if (this.audio.src && !this.audio.error) {
      this.playing = true;
      this.audio.play().catch(() => this.playAt(this.ch, this.ck));
      this.cb.onPlayState(true, false);
    } else {
      this.playAt(this.ch, this.ck);
    }
  }

  toggle() {
    if (this.playing) this.pause();
    else this.resume();
  }

  setRate(rate) {
    this.rate = rate;
    this.audio.playbackRate = rate;
  }

  setPosition(ch, ck) {
    this.loadSeq++;
    this.ch = ch;
    this.ck = ck;
    this.audio.removeAttribute("src");
    this.cb.onChunk(ch, ck);
    this.savePosition();
  }

  savePosition() {
    if (!this.book) return;
    this.book.position = { chapter: this.ch, chunk: this.ck };
    this.book.updatedAt = Date.now();
    dbPut("books", this.book).catch(() => {});
  }

  async prefetch() {
    if (this.prefetching) return;
    this.prefetching = true;
    try {
      let pos = [this.ch, this.ck];
      for (let n = 0; n < 3; n++) {
        pos = this.nextPos(pos[0], pos[1]);
        if (!pos || !this.playing) break;
        try {
          await this.getUrl(pos[0], pos[1]);
        } catch (e) {
          if (e.code === "points" || e.code === "key") {
            this.cb.onError(e);
            break;
          }
        }
      }
    } finally {
      this.prefetching = false;
    }
  }
}
