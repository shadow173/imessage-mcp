// What the bridge does with an attachment's file: previews (sips, Quick Look), extracted text (the Swift extractor for
// PDFs and OCR, textutil for documents) and the bytes behind download links.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from '../lib/errors.js';
import { MAX_FILE_BYTES } from '../relay/protocol.js';
import type { AttachmentCatalog } from './attachmentCatalog.js';
import type { LiveContext } from './context.js';
import { execChild } from './macos.js';

/** Runs a preview tool (sips, qlmanage) with a 20 s limit. */
async function run(cmd: string, args: string[]) {
  await execChild(cmd, args, { timeout: 20_000 });
}

export class AttachmentFiles {
  private extractor: Promise<string | null> | null = null;
  private extractorState: 'unchecked' | 'compiling' | 'ready' | 'unavailable' = 'unchecked';
  /** Why the extractor is unavailable: 'missing' (no Swift compiler) or the compiler's first error line. */
  private extractorError?: string;
  /** Recently extracted texts, so paging through a long PDF doesn't re-run the extractor for every page. */
  private textCache = new Map<string, string>();

  constructor(
    private ctx: LiveContext,
    private catalog: AttachmentCatalog,
  ) {}

  /** text_extraction for health: the extractor's state, with the reason when it couldn't be built. */
  extractorHealth(): string {
    return this.extractorState === 'unavailable' && this.extractorError
      ? `unavailable: ${this.extractorError === 'missing' ? 'Swift compiler missing' : this.extractorError}`
      : this.extractorState;
  }

  /** Photos via sips (HEIC -> JPEG, downscaled); videos and PDFs via a Quick Look thumbnail. */
  async attachmentPreview(id: string, maxDimension: number): Promise<{ mime: string; base64: string } | null> {
    const att = this.catalog.get(id);
    const path = this.catalog.path(id);
    if (!att || !path || !existsSync(path)) return null;
    const dir = mkdtempSync(join(tmpdir(), 'imessage-mcp-prev-'));
    try {
      if (att.kind === 'image' || att.kind === 'sticker') {
        const out = join(dir, 'p.jpg');
        await run('sips', [
          '-s',
          'format',
          'jpeg',
          '-s',
          'formatOptions',
          '80',
          '-Z',
          String(maxDimension),
          path,
          '--out',
          out,
        ]);
        return { mime: 'image/jpeg', base64: readFileSync(out).toString('base64') };
      }
      if (att.kind === 'video' || att.kind === 'pdf' || att.kind === 'document') {
        await run('qlmanage', ['-t', '-s', String(maxDimension), '-o', dir, path]);
        const png = readdirSync(dir).find((f) => f.endsWith('.png'));
        return png ? { mime: 'image/png', base64: readFileSync(join(dir, png)).toString('base64') } : null;
      }
      return null;
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Compiles the Swift text extractor once (PDFKit + Vision). Returns its path, or null if it can't be built.
   * The binary is rebuilt whenever the source's hash differs from the one it was built from.
   */
  private ensureExtractor(): Promise<string | null> {
    if (this.extractor) return this.extractor;
    this.extractorState = 'compiling';
    this.extractor = (async () => {
      // Next to this module: src/live under tsx, dist/live after a build (which copies the .swift file there).
      const src = fileURLToPath(new URL('./extract.swift', import.meta.url));
      const binDir = join(this.ctx.cfg.dataDir, 'bin');
      const bin = join(binDir, 'imessage-mcp-extract');
      const stamp = `${bin}.source-sha256`;
      try {
        const want = createHash('sha256').update(readFileSync(src)).digest('hex');
        if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === want) return bin;
        mkdirSync(binDir, { recursive: true, mode: 0o700 });
        await execChild('swiftc', ['-O', src, '-o', bin], { timeout: 180_000 });
        writeFileSync(stamp, want);
        return bin;
      } catch (e) {
        const err = e as NodeJS.ErrnoException & { stderr?: string };
        const stderr = String(err.stderr ?? '').trim();
        // Without Xcode Command Line Tools, /usr/bin/swiftc is a stub that fails through xcrun.
        if (err.code === 'ENOENT' || /xcrun: error|xcode-select/.test(stderr)) this.extractorError = 'missing';
        else {
          const lines = stderr.split('\n');
          this.extractorError = (lines.find((l) => /error/i.test(l)) || lines[0] || err.message).slice(0, 300);
          console.error('text extractor failed to build:', stderr || err.message);
        }
        return null;
      }
    })();
    void this.extractor.then((bin) => {
      this.extractorState = bin ? 'ready' : 'unavailable';
    });
    return this.extractor;
  }

  /** PDFs via PDFKit (OCR for scans), images via Vision OCR, Word/RTF/HTML/text via textutil. */
  async attachmentText(id: string): Promise<string | null> {
    const att = this.catalog.get(id);
    const path = this.catalog.path(id);
    if (!att || !path || !existsSync(path)) return null;
    const cached = this.textCache.get(id);
    if (cached !== undefined) {
      this.textCache.delete(id);
      this.textCache.set(id, cached);
      return cached;
    }
    let text: string | null = null;
    if (att.kind === 'pdf' || att.kind === 'image') {
      const bin = await this.ensureExtractor();
      if (!bin)
        throw this.extractorError && this.extractorError !== 'missing'
          ? new ToolError(
              'unavailable',
              `Text extraction isn't working on the Mac: the extractor failed to build (${this.extractorError}).`,
              'Tell the user; the bridge log has the details. Meanwhile mode=preview shows the first page.',
            )
          : new ToolError(
              'unavailable',
              "Text extraction isn't set up on the Mac: the Swift compiler (Xcode Command Line Tools) is missing.",
              'Tell the user; running xcode-select --install on the Mac fixes it. Meanwhile mode=preview shows the first page.',
            );
      try {
        text =
          (
            await execChild(bin, [att.kind === 'pdf' ? 'pdf' : 'ocr', path], {
              timeout: 60_000,
              maxBuffer: 20 * 1024 * 1024,
            })
          ).stdout.trim() || null;
      } catch {
        /* unreadable file */
      }
    } else if (
      att.kind === 'document' &&
      isAbsolute(path) &&
      /\.(docx?|rtf|rtfd|html?|txt|md|csv|odt|webarchive)$/i.test(path)
    ) {
      try {
        text =
          // -noload: never fetch the images or style sheets an HTML file or web archive points to (a read beacon,
          // or requests into the local network).
          (
            await execChild('textutil', ['-noload', '-convert', 'txt', '-stdout', path], {
              timeout: 30_000,
              maxBuffer: 20 * 1024 * 1024,
            })
          ).stdout.trim() || null;
      } catch {
        /* unreadable file */
      }
    }
    if (text) {
      this.textCache.set(id, text);
      if (this.textCache.size > 8) this.textCache.delete(this.textCache.keys().next().value!);
    }
    return text;
  }

  /** Warm the extractor at startup so the first request doesn't wait for a compile. */
  warmExtractor() {
    void this.ensureExtractor();
  }

  /**
   * null when missing, or when the served bytes would exceed MAX_FILE_BYTES (the bridge answers 413 when att.bytes is
   * over it).
   */
  async attachmentFile(id: string): Promise<{ mime: string; name: string; data: Buffer } | null> {
    const att = this.catalog.get(id);
    const path = this.catalog.path(id);
    if (!att || !path || !existsSync(path)) return null;
    if (/heic|heif/i.test(att.mime) || /\.heic$/i.test(path)) {
      const prev = await this.attachmentPreview(id, 4096);
      if (prev) {
        const data = Buffer.from(prev.base64, 'base64');
        return data.length <= MAX_FILE_BYTES
          ? { mime: prev.mime, name: att.name.replace(/\.heic$/i, '.jpg'), data }
          : null;
      }
    }
    if (statSync(path).size > MAX_FILE_BYTES) return null;
    return { mime: att.mime, name: att.name, data: readFileSync(path) };
  }
}
