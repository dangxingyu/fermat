const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * TexCompiler
 *
 * Handles LaTeX → PDF compilation.
 * Supports pdflatex, xelatex, lualatex, tectonic.
 *
 * Auto-detects available engine on startup if default not found.
 */
class TexCompiler {
  constructor() {
    this.engine = null; // will auto-detect
    this.tmpDir = path.join(os.tmpdir(), 'fermat-tex');
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
    this._autoDetectEngine();
  }

  setEngine(engine) {
    this.engine = engine;
    console.log(`[TexCompiler] Engine set to: ${engine}`);
  }

  /**
   * Try to find an available LaTeX engine on the system.
   */
  _autoDetectEngine() {
    const candidates = ['tectonic', 'pdflatex', 'xelatex', 'lualatex'];
    const { execFileSync } = require('child_process');

    const extendedPATH = process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/Library/TeX/texbin';
    for (const eng of candidates) {
      try {
        execFileSync('which', [eng], {
          timeout: 3000,
          stdio: 'pipe',
          env: { ...process.env, PATH: extendedPATH },
        });
        this.engine = eng;
        console.log(`[TexCompiler] Auto-detected engine: ${eng}`);
        return;
      } catch {
        // not found, try next
      }
    }

    this.engine = 'pdflatex'; // fallback even if not found
    console.warn('[TexCompiler] No LaTeX engine found! Compilation will fail.');
  }

  /**
   * Pre-process LaTeX source so that Fermat-specific markers
   * (% [PROVE IT: ...]) render as visible placeholders in the PDF.
   *
   * The original .tex file is never modified — we write a temporary
   * copy with the transformations applied.
   */
  _preprocessSource(source) {
    // ── 1. Inject the \fermatprove command before \begin{document} ───────
    //    Uses only xcolor (ships with every TeX distribution).
    //    We guard with \providecommand so it's safe if the user defines their own.
    const markerCmd = [
      '',
      '% ── Fermat marker (injected at compile time) ──',
      '\\usepackage{xcolor}',
      '\\providecommand{\\fermatprove}[1]{%',
      '  \\par\\vspace{4pt}\\noindent',
      '  \\fcolorbox{blue!40}{blue!6}{%',
      '    \\small\\sffamily\\textcolor{blue!70}{\\textbf{\\(\\circlearrowleft\\) PROVE:} #1}%',
      '  }\\par\\vspace{4pt}%',
      '}',
      '',
    ].join('\n');

    let out = source;

    // Insert before \begin{document} (or at the very end of the preamble)
    const docStart = out.indexOf('\\begin{document}');
    if (docStart !== -1) {
      out = out.slice(0, docStart) + markerCmd + out.slice(docStart);
    }

    // ── 2. Replace  % [PROVE IT: X]  with  \fermatprove{X} ─────────────
    //    Preserves SKETCH comments (they stay invisible).
    // S-04: sanitise the captured difficulty so braces / backslashes in the
    // marker can't break the \fermatprove{} argument or inject LaTeX macros.
    out = out.replace(
      /^(\s*)%\s*\[PROVE\s+IT:\s*([^\]]+)\]\s*$/gm,
      (_m, indent, label) => {
        const safe = String(label)
          .replace(/\\/g, '\\textbackslash{}')
          .replace(/[{}]/g, '')
          .replace(/#/g, '\\#')
          .replace(/\$/g, '\\$')
          .replace(/%/g, '\\%')
          .replace(/&/g, '\\&')
          .replace(/_/g, '\\_')
          .replace(/\^/g, '\\^{}')
          .replace(/~/g, '\\~{}')
          .trim();
        return `${indent}\\fermatprove{${safe}}`;
      },
    );

    return out;
  }

  /**
   * Compile LaTeX content to PDF.
   * Returns: { success, pdfPath, pdfData, log, errors }
   */
  async compile(filePath, content) {
    // Always compile a preprocessed copy so the user's .tex is untouched.
    const processed = this._preprocessSource(content || '');

    let texPath;
    let workDir;         // cwd for the compile subprocess
    let outputDir;       // where PDF/aux/synctex land

    if (!filePath || !fs.existsSync(filePath)) {
      // No source file on disk yet — compile entirely in tmpDir.
      texPath = path.join(this.tmpDir, 'document.tex');
      fs.writeFileSync(texPath, processed, 'utf-8');
      workDir = this.tmpDir;
      outputDir = this.tmpDir;
      this._sourceDir = null;
    } else {
      // Write preprocessed copy INTO the source dir with a dotted prefix
      // (hidden). Compile with cwd=sourceDir so \input{macros}, graphics,
      // \bibliography all resolve via relative paths — works with tectonic,
      // pdflatex, xelatex uniformly. PDF lands alongside the source too,
      // so users can open it from the source folder directly.
      const sourceDir = path.dirname(filePath);
      const baseName = path.basename(filePath, path.extname(filePath));
      texPath = path.join(sourceDir, `.${baseName}.fermat.tex`);
      fs.writeFileSync(texPath, processed, 'utf-8');
      workDir = sourceDir;
      outputDir = sourceDir;
      this._sourceDir = sourceDir;
    }

    // PDF/synctex are named after the compiled tex basename (e.g. ".main.fermat.pdf").
    const texBase = path.basename(texPath, '.tex');
    let pdfPath = path.join(outputDir, `${texBase}.pdf`);
    let synctexPath = path.join(outputDir, `${texBase}.synctex.gz`);

    console.log(`[TexCompiler] Compiling with ${this.engine}: ${texPath} (cwd=${workDir}, out=${outputDir})`);

    try {
      const log = await this._runEngine(texPath, workDir, outputDir);

      // B-05: keep the hidden ".foo.fermat.tex" on disk after compile. The
      // .synctex.gz has internal references to this path, and the returned
      // texPath points here; deleting it would make forward search silently
      // fail every time. The file is overwritten on each compile anyway.

      // Rename outputs from ".main.fermat.*" → "main.*" in the source dir
      // so the user sees a clean main.pdf next to main.tex. Also clean up
      // ancillary files (.aux, .log, .out, .toc, .fdb_latexmk, .fls).
      if (this._sourceDir && filePath) {
        const userBase = path.basename(filePath, path.extname(filePath));
        const rename = (ext) => {
          const src = path.join(outputDir, `${texBase}${ext}`);
          const dst = path.join(outputDir, `${userBase}${ext}`);
          if (fs.existsSync(src)) {
            try { fs.renameSync(src, dst); } catch {}
          }
        };
        rename('.pdf');
        rename('.synctex.gz');
        // Remove hidden ancillary files rather than exposing them.
        for (const ext of ['.aux', '.log', '.out', '.toc', '.fdb_latexmk', '.fls', '.bbl', '.blg']) {
          const f = path.join(outputDir, `${texBase}${ext}`);
          if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch {} }
        }
        pdfPath = path.join(outputDir, `${userBase}.pdf`);
        synctexPath = path.join(outputDir, `${userBase}.synctex.gz`);
      }

      const pdfExists = fs.existsSync(pdfPath);
      const synctexExists = fs.existsSync(synctexPath);

      if (pdfExists) {
        console.log(`[TexCompiler] Success: ${pdfPath}`);
      } else {
        console.log(`[TexCompiler] PDF not found after compilation`);
      }
      if (synctexExists) {
        console.log(`[TexCompiler] SyncTeX available: ${synctexPath}`);
      }

      return {
        success: pdfExists,
        pdfPath: pdfExists ? pdfPath : null,
        pdfData: pdfExists ? fs.readFileSync(pdfPath).toString('base64') : null,
        synctexPath: synctexExists ? synctexPath : null,
        texPath,
        log,
        errors: pdfExists ? [] : this._extractErrors(log),
      };
    } catch (err) {
      console.error(`[TexCompiler] Error:`, err.message);
      return {
        success: false,
        pdfPath: null,
        pdfData: null,
        log: err.message,
        errors: [err.message],
      };
    }
  }

  _runEngine(texPath, workDir, outputDir) {
    return new Promise((resolve, reject) => {
      let args;
      outputDir = outputDir || workDir;

      switch (this.engine) {
        case 'tectonic':
          args = [
            texPath,
            '--outdir', outputDir,
            '--chatter', 'minimal',
            '--synctex',
          ];
          break;

        default:
          // pdflatex, xelatex, lualatex
          args = [
            '-synctex=1',
            '-interaction=nonstopmode',
            '-halt-on-error',
            `-output-directory=${outputDir}`,
            texPath,
          ];
          break;
      }

      console.log(`[TexCompiler] Running: ${this.engine} ${args.join(' ')}`);

      // Let LaTeX find \input{macros}, \includegraphics{fig}, etc. from the
      // user's source directory. TEXINPUTS uses ':' as path sep on Unix.
      // Trailing '//' means recurse; trailing ':' appends the default path.
      const texInputs = this._sourceDir
        ? `${this._sourceDir}//:${process.env.TEXINPUTS || ''}`
        : (process.env.TEXINPUTS || '');
      const bibInputs = this._sourceDir
        ? `${this._sourceDir}//:${process.env.BIBINPUTS || ''}`
        : (process.env.BIBINPUTS || '');

      execFile(this.engine, args, {
        cwd: workDir,
        timeout: 60000,  // tectonic downloads packages on first run, needs more time
        env: {
          ...process.env,
          PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin',
          TEXINPUTS: texInputs,
          BIBINPUTS: bibInputs,
        },
      }, (err, stdout, stderr) => {
        const log = (stdout || '') + '\n' + (stderr || '');

        if (err && err.killed) {
          reject(new Error('Compilation timed out (60s limit). If using tectonic, it may be downloading packages — try again.'));
        } else if (err && !fs.existsSync(path.join(outputDir, path.basename(texPath).replace(/\.tex$/, '.pdf')))) {
          // Real error — non-zero exit and no PDF produced
          resolve(log); // resolve anyway, let caller check PDF existence
        } else {
          resolve(log);
        }
      });
    });
  }

  _extractErrors(log) {
    const errors = [];
    const lines = log.split('\n');
    for (const line of lines) {
      if (line.startsWith('!') || line.includes('Fatal error') || line.includes('error:')) {
        errors.push(line.trim());
      }
    }
    return errors.length > 0 ? errors : ['Compilation failed — check the log for details'];
  }
}

module.exports = { TexCompiler };
