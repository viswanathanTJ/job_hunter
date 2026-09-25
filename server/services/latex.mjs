// LaTeX compilation for tailored resumes.
//
// Resume/build-tex.sh is the authority on how the real resume is built and what
// counts as acceptable output. This module mirrors it deliberately: the same
// tectonic binary, the same page/A4/text-layer gate. A tailored resume that the
// base build would have rejected must not reach the user either.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';

/** tectonic is a standalone binary; build-tex.sh looks in the same two places. */
export function tectonicPath() {
  if (process.env.TECTONIC && fs.existsSync(process.env.TECTONIC)) return process.env.TECTONIC;
  for (const p of [
    path.join(os.homedir(), '.local', 'bin', 'tectonic'),
    '/usr/local/bin/tectonic',
    '/usr/bin/tectonic',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execFileSync('command', ['-v', 'tectonic'], { shell: true, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });

/** Page count and paper size, read from the PDF itself rather than trusted. */
function pdfFacts(pdfPath) {
  const info = run('pdfinfo', [pdfPath]);
  const pages = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1]);
  return { pages: Number.isFinite(pages) ? pages : null, isA4: /A4/.test(info) };
}

// The same keywords build-tex.sh greps for. A PDF with no extractable text is
// useless to an ATS, so a silently broken build must not ship.
const TEXT_MARKERS = ['Viswanathan', 'Skills', 'Experience', 'Education'];

/**
 * The build-tex.sh gate, as a value rather than an exit code.
 * Returns { ok, pages, reason } — never throws, so callers can fall back.
 */
export function verifyPdf(pdfPath, { pageBudget = 1, markers = TEXT_MARKERS } = {}) {
  if (!pdfPath || !fs.existsSync(pdfPath)) return { ok: false, pages: null, reason: 'no PDF was produced' };
  let facts;
  try {
    facts = pdfFacts(pdfPath);
  } catch (e) {
    return { ok: false, pages: null, reason: `could not read the PDF: ${e.message}` };
  }
  const { pages, isA4 } = facts;
  if (pages !== pageBudget) {
    return { ok: false, pages, reason: `it is ${pages} page${pages === 1 ? '' : 's'}, budget ${pageBudget}` };
  }
  if (!isA4) return { ok: false, pages, reason: 'it is not A4' };
  let text = '';
  try {
    text = run('pdftotext', [pdfPath, '-']);
  } catch (e) {
    return { ok: false, pages, reason: `could not read the text layer: ${e.message}` };
  }
  const missing = markers.filter((m) => !text.toLowerCase().includes(m.toLowerCase()));
  if (missing.length) return { ok: false, pages, reason: `text layer is missing ${missing.join(', ')}` };
  return { ok: true, pages, reason: null };
}

/**
 * Compile `texPath` in its own directory and return the PDF path.
 * tectonic fetches missing TeX packages on first use, hence the generous timeout.
 */
export function compileTex(texPath, { timeoutMs = 180_000 } = {}) {
  const bin = tectonicPath();
  if (!bin) throw new Error('tectonic not found — set TECTONIC to its path');
  const dir = path.dirname(texPath);
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['-X', 'compile', texPath, '--outdir', dir],
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const pdf = texPath.replace(/\.tex$/, '.pdf');
        // tectonic warns noisily and still succeeds; the PDF existing is the
        // real success signal, so check that before trusting the exit code.
        if (fs.existsSync(pdf)) return resolve(pdf);
        const detail = String(stderr || stdout || err?.message || '')
          .split('\n')
          .filter((l) => /error|Error|fatal/.test(l))
          .slice(0, 5)
          .join('; ');
        reject(new Error(`tectonic produced no PDF${detail ? `: ${detail}` : ''}`));
      }
    );
  });
}
