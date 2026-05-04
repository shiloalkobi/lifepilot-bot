'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pubmed = require('../skills/research/sources/pubmed');
const { parseEfetchXml, parseAuthors, parsePublishedAt, decodeXml } = pubmed;

const FIX_DIR = path.join(__dirname, 'fixtures', 'pubmed');

test('adapter shape: name, rateLimit, parseId, healthCheck, fetch', () => {
  assert.equal(pubmed.name, 'pubmed');
  assert.equal(typeof pubmed.fetch, 'function');
  assert.equal(typeof pubmed.parseId, 'function');
  assert.equal(typeof pubmed.healthCheck, 'function');
  assert.ok(pubmed.rateLimit.requestsPerSecond > 0);
  assert.ok(pubmed.rateLimit.burst > 0);
});

test('decodeXml strips tags and decodes named entities', () => {
  assert.equal(decodeXml('<i>foo</i> &amp; <b>bar</b>'), 'foo & bar');
  assert.equal(decodeXml('A &lt; B &gt; C &quot;d&quot; &apos;e&apos;'), 'A < B > C "d" \'e\'');
});

test('decodeXml decodes numeric entities', () => {
  assert.equal(decodeXml('&#945; &#x03B2;'), 'α β');
});

test('parseAuthors handles LastName + ForeName', () => {
  const xml = `
    <AuthorList>
      <Author><LastName>Birklein</LastName><ForeName>Frank</ForeName></Author>
      <Author><LastName>Goebel</LastName><ForeName>Andreas</ForeName></Author>
    </AuthorList>`;
  assert.deepEqual(parseAuthors(xml), ['Frank Birklein', 'Andreas Goebel']);
});

test('parseAuthors falls back to CollectiveName', () => {
  const xml = `<Author><CollectiveName>CRPS Working Group</CollectiveName></Author>`;
  assert.deepEqual(parseAuthors(xml), ['CRPS Working Group']);
});

test('parsePublishedAt prefers Year/Month/Day', () => {
  const block = `<PubDate><Year>2025</Year><Month>Mar</Month><Day>14</Day></PubDate>`;
  assert.equal(parsePublishedAt(block), '2025-03-14');
});

test('parsePublishedAt accepts numeric month', () => {
  const block = `<PubDate><Year>2025</Year><Month>03</Month><Day>14</Day></PubDate>`;
  assert.equal(parsePublishedAt(block), '2025-03-14');
});

test('parsePublishedAt falls back to MedlineDate', () => {
  const block = `<PubDate><MedlineDate>2025 Spring</MedlineDate></PubDate>`;
  assert.equal(parsePublishedAt(block), '2025-01-01');
});

test('parsePublishedAt returns null when PubDate missing', () => {
  assert.equal(parsePublishedAt('<other/>'), null);
});

test('parseEfetchXml parses live-captured fixture', () => {
  const xml = fs.readFileSync(path.join(FIX_DIR, 'efetch.xml'), 'utf8');
  const articles = parseEfetchXml(xml);
  assert.ok(articles.length >= 1, 'at least one article parsed from fixture');
  const a = articles[0];
  assert.equal(a.source, 'pubmed');
  assert.match(a.source_id, /^\d+$/);
  assert.ok(a.title && a.title.length > 0);
  assert.match(a.url, /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/);
  assert.ok(Array.isArray(a.authors));
});

test('parseEfetchXml returns empty array on no-article XML', () => {
  assert.deepEqual(parseEfetchXml('<PubmedArticleSet></PubmedArticleSet>'), []);
});

test('parseId returns article.source_id', () => {
  assert.equal(pubmed.parseId({ source_id: 'PMID42' }), 'PMID42');
});

test('fetchImpl orchestration: esearch → efetch (mocked fetch)', async (t) => {
  const captured = [];
  const original = globalThis.fetch;
  const efetchXml = fs.readFileSync(path.join(FIX_DIR, 'efetch.xml'), 'utf8');
  globalThis.fetch = async (url) => {
    captured.push(String(url));
    if (url.includes('esearch.fcgi')) {
      return new Response(JSON.stringify({
        esearchresult: { idlist: ['42066272', '42066256'] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('efetch.fcgi')) {
      return new Response(efetchXml, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    return new Response('not found', { status: 404 });
  };
  t.after(() => { globalThis.fetch = original; });

  const out = await pubmed.fetch(null, new Date('2026-01-01'));
  assert.equal(captured.length, 2, 'exactly 2 calls (esearch + efetch)');
  assert.match(captured[0], /esearch\.fcgi/);
  assert.match(captured[1], /efetch\.fcgi/);
  assert.ok(out.length >= 1);
  assert.equal(out[0].source, 'pubmed');
});

test('fetchImpl returns [] when esearch yields no PMIDs', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 });
  t.after(() => { globalThis.fetch = original; });
  const out = await pubmed.fetch('zzz nonexistent', new Date());
  assert.deepEqual(out, []);
});

test('fetchImpl throws on esearch HTTP error', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('rate limited', { status: 429 });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(pubmed.fetch(null, new Date()), /esearch failed: HTTP 429/);
});
