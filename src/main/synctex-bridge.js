const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * SyncTeX Bridge
 *
 * Provides forward search (LaTeX line → PDF position) and
 * inverse search (PDF click → LaTeX line) by either:
 *   1. Using the `synctex` CLI tool (preferred, most accurate)
 *   2. Falling back to a built-in .synctex.gz parser
 *
 * The synctex CLI is bundled with TeX Live and tectonic.
 */
class SynctexBridge {
  constructor() {
    this._synctexPath = null;
    this._hasCli = null;
    this._detectCli();
  }

  _detectCli() {
    const { execFileSync } = require('child_process');
    // Try `which synctex` first using extended PATH
    try {
      const result = execFileSync('which', ['synctex'], {
        timeout: 3000,
        stdio: 'pipe',
        env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/Library/TeX/texbin' },
      });
      this._synctexPath = result.toString().trim();
      this._hasCli = true;
      console.log(`[SyncTeX] CLI found: ${this._synctexPath}`);
      return;
    } catch {
      // not found via which
    }

    // Try known absolute paths directly
    const candidates = [
      '/Library/TeX/texbin/synctex',
      '/opt/homebrew/bin/synctex',
      '/usr/local/bin/synctex',
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          this._synctexPath = p;
          this._hasCli = true;
          console.log(`[SyncTeX] CLI found at: ${p}`);
          return;
        }
      } catch {
        // skip
      }
    }

    this._hasCli = false;
    console.log('[SyncTeX] CLI not found — will use built-in parser');
  }

  /**
   * Forward search: given a line in the .tex file, find where it appears in the PDF.
   * Returns: { page, x, y, width, height } or null
   */
  async forwardSearch(synctexPath, texPath, line) {
    if (!synctexPath || !fs.existsSync(synctexPath)) return null;

    if (this._hasCli) {
      return this._cliForward(synctexPath, texPath, line);
    }
    return this._parseForward(synctexPath, texPath, line);
  }

  /**
   * Inverse search: given a click position on a PDF page, find the source line.
   * Returns: { file, line, column } or null
   */
  async inverseSearch(synctexPath, pdfPage, x, y) {
    if (!synctexPath || !fs.existsSync(synctexPath)) return null;

    if (this._hasCli) {
      return this._cliInverse(synctexPath, pdfPage, x, y);
    }
    return this._parseInverse(synctexPath, pdfPage, x, y);
  }

  // ─── CLI-based methods ─────────────────────────────────────────

  _cliForward(synctexPath, texPath, line) {
    // synctex view -i "line:0:texfile" -o "pdffile"
    const pdfPath = synctexPath.replace(/\.synctex\.gz$/, '.pdf');
    return new Promise((resolve) => {
      execFile(this._synctexPath, [
        'view',
        '-i', `${line}:0:${texPath}`,
        '-o', pdfPath,
      ], {
        timeout: 5000,
        env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/Library/TeX/texbin' },
      }, (err, stdout) => {
        if (err) {
          console.error('[SyncTeX] Forward search error:', err.message);
          resolve(null);
          return;
        }
        resolve(this._parseViewOutput(stdout));
      });
    });
  }

  _cliInverse(synctexPath, page, x, y) {
    // synctex edit -o "page:x:y:pdffile"
    const pdfPath = synctexPath.replace(/\.synctex\.gz$/, '.pdf');
    return new Promise((resolve) => {
      execFile(this._synctexPath, [
        'edit',
        '-o', `${page}:${x}:${y}:${pdfPath}`,
      ], {
        timeout: 5000,
        env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/Library/TeX/texbin' },
      }, (err, stdout) => {
        if (err) {
          console.error('[SyncTeX] Inverse search error:', err.message);
          resolve(null);
          return;
        }
        resolve(this._parseEditOutput(stdout));
      });
    });
  }

  _parseViewOutput(output) {
    // Parse synctex view output:
    // Page:1
    // x:72.26999
    // y:86.72377
    // h:72.26999
    // v:86.72377
    // W:469.75502
    // H:12.0
    const result = {};
    for (const line of output.split('\n')) {
      const [key, val] = line.split(':').map(s => s.trim());
      if (key === 'Page') result.page = parseInt(val);
      else if (key === 'x') result.x = parseFloat(val);
      else if (key === 'y') result.y = parseFloat(val);
      else if (key === 'W') result.width = parseFloat(val);
      else if (key === 'H') result.height = parseFloat(val);
      else if (key === 'h') result.h = parseFloat(val);
      else if (key === 'v') result.v = parseFloat(val);
    }
    if (result.page) return result;
    return null;
  }

  _parseEditOutput(output) {
    // Parse synctex edit output:
    // Input:/path/to/file.tex
    // Line:42
    // Column:0
    const result = {};
    for (const line of output.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.substring(0, colonIdx).trim();
      const val = line.substring(colonIdx + 1).trim();
      if (key === 'Input') result.file = val;
      else if (key === 'Line') result.line = parseInt(val);
      else if (key === 'Column') result.column = parseInt(val);
    }
    if (result.line) return result;
    return null;
  }

  // ─── Built-in parser fallback ──────────────────────────────────

  /**
   * Parse synctex.gz file into an array of records.
   * Each record: { type, page, line, column, file, x, y, w, h }
   */
  _parseSynctexFile(synctexPath) {
    try {
      const compressed = fs.readFileSync(synctexPath);
      const raw = zlib.gunzipSync(compressed).toString('utf-8');
      return this._parseSynctexContent(raw);
    } catch (err) {
      console.error('[SyncTeX] Parse error:', err.message);
      return null;
    }
  }

  _parseSynctexContent(content) {
    const lines = content.split('\n');
    const inputs = {};  // tag → file path
    let currentPage = 0;
    const records = [];

    for (const line of lines) {
      // Input entries: Input:tag:filepath
      if (line.startsWith('Input:')) {
        const rest = line.substring(6);
        const colonIdx = rest.indexOf(':');
        if (colonIdx > 0) {
          const tag = parseInt(rest.substring(0, colonIdx));
          const filePath = rest.substring(colonIdx + 1);
          inputs[tag] = filePath;
        }
        continue;
      }

      // Page opening: {pageNum
      if (line.startsWith('{')) {
        currentPage = parseInt(line.substring(1)) || currentPage;
        continue;
      }

      // Horizontal box, vertical box, current point, kern, glue, math
      // Format varies but common patterns:
      // x or k or $ or ( lines: tag:line:column:x:y:W:H:D
      // h or v lines (boxes): tag:line:column:x:y:W:H:D
      const recordMatch = line.match(/^([xkvghm\$\(\)])(\d+),(\d+)(?::(-?\d+))?:(-?[\d.]+):(-?[\d.]+)(?::(-?[\d.]+):(-?[\d.]+):(-?[\d.]+))?/);
      if (recordMatch) {
        const [, type, fileTag, lineNum, col, x, y, w, h, d] = recordMatch;
        records.push({
          type,
          page: currentPage,
          fileTag: parseInt(fileTag),
          file: inputs[parseInt(fileTag)],
          line: parseInt(lineNum),
          column: parseInt(col || '0'),
          x: parseFloat(x),
          y: parseFloat(y),
          w: parseFloat(w || '0'),
          h: parseFloat(h || '0'),
          d: parseFloat(d || '0'),
        });
      }
    }

    return { inputs, records };
  }

  _parseForward(synctexPath, texPath, targetLine) {
    const parsed = this._parseSynctexFile(synctexPath);
    if (!parsed) return null;

    const baseName = path.basename(texPath);
    // Find records matching this source line
    let bestRecord = null;
    let bestDist = Infinity;

    for (const rec of parsed.records) {
      if (!rec.file) continue;
      if (!rec.file.endsWith(baseName) && rec.file !== texPath) continue;

      const dist = Math.abs(rec.line - targetLine);
      if (dist < bestDist) {
        bestDist = dist;
        bestRecord = rec;
      }
    }

    if (!bestRecord) return null;

    return {
      page: bestRecord.page,
      x: bestRecord.x,
      y: bestRecord.y,
      width: bestRecord.w,
      height: bestRecord.h,
    };
  }

  _parseInverse(synctexPath, targetPage, targetX, targetY) {
    const parsed = this._parseSynctexFile(synctexPath);
    if (!parsed) return null;

    // Find the record closest to the click position on the target page
    let bestRecord = null;
    let bestDist = Infinity;

    for (const rec of parsed.records) {
      if (rec.page !== targetPage) continue;
      if (!rec.file) continue;

      // Euclidean distance from click to record position
      const dx = targetX - rec.x;
      const dy = targetY - rec.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < bestDist) {
        bestDist = dist;
        bestRecord = rec;
      }
    }

    if (!bestRecord) return null;

    return {
      file: bestRecord.file,
      line: bestRecord.line,
      column: bestRecord.column,
    };
  }
}

module.exports = { SynctexBridge };
