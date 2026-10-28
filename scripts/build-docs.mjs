import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'docs');
const output = path.join(root, 'docs-site');
const repo = 'https://github.com/FreshOnTime/Agentic-FreshPick';
const files = (await fs.readdir(source)).filter(name => name.endsWith('.md')).sort();
const pages = new Map();
const htmlName = file => file === 'README.md' ? 'index.html' : file.replace(/\.md$/, '.html');
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const plain = children => React.Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : React.isValidElement(child) ? plain(child.props.children) : '').join('');
const navGroups = [
  ['Platform', ['README.md', 'AGENTIC_ARCHITECTURE.md', 'FEATURES.md', 'ROADMAP.md']],
  ['Integrate', ['mcp.md', 'A2A.md', 'API_REFERENCE.md']],
  ['Build & deploy', ['DEVELOPER_GUIDE.md', 'VERCEL_DEPLOYMENT.md', 'GITHUB_PAGES.md', 'ARCHITECTURE.md', 'FUNCTION_REFERENCE.md']],
  ['Operate', ['ADMIN_GUIDE.md', 'SUBSCRIPTIONS.md', 'OPERATIONS.md', 'PLATFORM_READINESS.md']],
];
const labels = { 'README.md': 'Overview', 'AGENTIC_ARCHITECTURE.md': 'Agentic architecture', 'mcp.md': 'MCP tools', 'A2A.md': 'A2A quotations', 'VERCEL_DEPLOYMENT.md': 'Deploy on Vercel', 'GITHUB_PAGES.md': 'Documentation publishing' };
for (const file of files) {
  const markdown = await fs.readFile(path.join(source, file), 'utf8');
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] || file.replace('.md', '');
  pages.set(file, { title, markdown });
}
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.copyFile(path.join(source, 'site/style.css'), path.join(output, 'style.css'));
await fs.copyFile(path.join(source, 'site/search.js'), path.join(output, 'search.js'));
await fs.writeFile(path.join(output, '.nojekyll'), '');
const search = [];
for (const [file, page] of pages) {
  const headings = []; const slugs = new Map();
  const components = {};
  for (let level = 1; level <= 6; level++) components[`h${level}`] = ({ children }) => {
    const title = plain(children);
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = slugs.get(base) || 0; slugs.set(base, count + 1);
    const id = count ? `${base}-${count}` : base;
    if (level === 2) headings.push({ id, title });
    return React.createElement(`h${level}`, { id }, children);
  };
  components.a = ({ href = '', children }) => {
    if (!/^(?:[a-z]+:|\/\/|#)/i.test(href)) {
      const [pathname, anchor = ''] = href.split('#');
      const resolved = path.posix.normalize(path.posix.join('docs', pathname));
      if (resolved.startsWith('docs/') && pages.has(resolved.slice(5))) href = `${htmlName(resolved.slice(5))}${anchor ? `#${anchor}` : ''}`;
      else href = `${repo}/blob/main/${resolved}${anchor ? `#${anchor}` : ''}`;
    }
    return React.createElement('a', { href }, children);
  };
  const body = renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSanitize], components }, page.markdown));
  const nav = navGroups.map(([label, entries]) => `<div class="nav-group"><p>${label}</p>${entries.filter(entry => pages.has(entry)).map(entry => `<a ${entry === file ? 'aria-current="page"' : ''} href="${htmlName(entry)}">${escape(labels[entry] || pages.get(entry).title.replace(/^FreshPick\s*/i, ''))}</a>`).join('')}</div>`).join('');
  const toc = headings.map(({ id, title }) => `<a href="#${escape(id)}">${escape(title)}</a>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="FreshPick platform documentation: commerce, AI assistants, MCP and A2A quotations."><title>${escape(page.title)} · FreshPick Docs</title><link rel="stylesheet" href="style.css"><script defer src="search.js"></script></head><body>
<a class="skip" href="#content">Skip to content</a><header><a class="brand" href="index.html"><span class="mark">F</span>FreshPick <span class="docs-label">Docs</span></a><a class="repo" href="${repo}">View on GitHub ↗</a></header>
<div class="layout"><aside class="sidebar"><label for="docs-search">Search the guides</label><input id="docs-search" type="search" placeholder="MCP, deployment, orders…" autocomplete="off"><div id="search-results" aria-live="polite"></div><details class="navigation" open><summary>Browse documentation</summary><nav aria-label="Documentation">${nav}</nav></details></aside>
<main id="content"><div class="eyebrow">FRESHPICK / PLATFORM DOCUMENTATION</div><article>${body}</article><footer><a href="${repo}/edit/main/docs/${file}">Edit this guide on GitHub ↗</a><p>Implementation guides describe source behavior. Deployment verification is recorded separately.</p></footer></main><aside class="toc"><p>ON THIS PAGE</p>${toc}</aside></div></body></html>`;
  await fs.writeFile(path.join(output, htmlName(file)), html);
  search.push({ title: page.title, href: htmlName(file), text: page.markdown.replace(/[`#*|]/g, '').replace(/\s+/g, ' ').slice(0, 100000) });
}
await fs.writeFile(path.join(output, 'search-index.json'), JSON.stringify(search));
// All local page/asset references must exist. Source-code links stay on GitHub.
for (const file of await fs.readdir(output)) {
  if (!file.endsWith('.html')) continue;
  const html = await fs.readFile(path.join(output, file), 'utf8');
  for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(url)) continue;
    await fs.access(path.join(output, url.split('#')[0]));
  }
}
console.log(`Built and checked ${pages.size} documentation pages in docs-site/.`);
