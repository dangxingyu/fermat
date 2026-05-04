import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  normalizeSearchPlan,
  parseArxivAtom,
  parseBibEntries,
  parseCrossrefWorks,
  persistResearchRun,
  runNativeSourceSearch,
  searchLocalBib,
} from '../native-research.js';

describe('native research providers', () => {
  it('parses arXiv Atom search results into source cards', () => {
    const atom = `
      <feed>
        <entry>
          <id>http://arxiv.org/abs/2302.05537v1</id>
          <title>Improved bounds on arithmetic progressions</title>
          <summary>We prove a new upper bound.</summary>
          <published>2023-02-10T00:00:00Z</published>
          <author><name>Kelley</name></author>
          <author><name>Meka</name></author>
        </entry>
      </feed>`;

    const cards = parseArxivAtom(atom);

    expect(cards[0]).toMatchObject({
      sourceType: 'arxiv',
      title: 'Improved bounds on arithmetic progressions',
      year: '2023',
      identifiers: { arxiv: '2302.05537v1' },
    });
    expect(cards[0].authors).toEqual(['Kelley', 'Meka']);
  });

  it('parses Crossref works into DOI source candidates', () => {
    const works = {
      message: {
        items: [{
          title: ['A published theorem'],
          DOI: '10.1111/example',
          URL: 'https://doi.org/10.1111/example',
          issued: { 'date-parts': [[2024]] },
          author: [{ given: 'A.', family: 'Author' }],
        }],
      },
    };

    expect(parseCrossrefWorks(works)[0]).toMatchObject({
      sourceType: 'doi',
      title: 'A published theorem',
      year: '2024',
      identifiers: { doi: '10.1111/example' },
    });
  });

  it('searches local bib files with query tokens', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-bib-'));
    fs.writeFileSync(path.join(root, 'refs.bib'), `
      @article{kelley_meka,
        title={Strong bounds for arithmetic progressions},
        author={Kelley and Meka},
        year={2023},
        eprint={2302.05537}
      }
    `);

    const results = searchLocalBib(root, 'arithmetic progressions', { maxResults: 2 });

    expect(results).toHaveLength(1);
    expect(results[0].identifiers.bibKey).toBe('kelley_meka');
    expect(parseBibEntries(fs.readFileSync(path.join(root, 'refs.bib'), 'utf-8'))[0].title).toContain('Strong bounds');
  });

  it('runs deterministic mocked native search and persists the search run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-research-run-'));
    const plan = normalizeSearchPlan({
      queries: [{ id: 'q1', provider: 'arxiv', query: 'progressions', expectedClaim: 'Need a bound.' }],
    }, { target: { name: 'Target' }, obligations: [] });

    const run = await runNativeSourceSearch(plan, {
      runId: 'search-test',
      fetchText: async () => `
        <feed><entry>
          <id>http://arxiv.org/abs/1111.2222</id>
          <title>Progressions</title>
          <summary>Abstract.</summary>
          <published>2020-01-01T00:00:00Z</published>
        </entry></feed>`,
      budget: { maxResultsPerQuery: 1, maxSources: 1 },
    });
    const filePath = persistResearchRun(run, path.join(root, '.fermat'));

    expect(run.status).toBe('completed');
    expect(run.sourceCards).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).runId).toBe('search-test');
  });
});
