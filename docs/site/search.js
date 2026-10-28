(() => {
  const input = document.getElementById('docs-search');
  const results = document.getElementById('search-results');
  let index;
  let load;
  const search = async () => {
    const query = input.value.trim().toLowerCase();
    results.replaceChildren();
    if (query.length < 2) return;
    try {
      load ||= fetch('search-index.json').then(response => { if (!response.ok) throw new Error(); return response.json(); });
      index ||= await load;
      if (input.value.trim().toLowerCase() !== query) return;
      const words = query.split(/\s+/);
      const matches = index.filter(page => words.every(word => `${page.title} ${page.text}`.toLowerCase().includes(word)))
        .sort((a, b) => Number(b.title.toLowerCase().includes(query)) - Number(a.title.toLowerCase().includes(query))).slice(0, 8);
      for (const page of matches) {
        const link = document.createElement('a'); link.href = page.href; link.textContent = page.title; results.append(link);
      }
      if (!matches.length) { const text = document.createElement('p'); text.textContent = 'No matching guides. Try a shorter phrase.'; results.append(text); }
    } catch { results.textContent = 'Search is unavailable. Use the guide navigation below.'; load = undefined; }
  };
  input.addEventListener('input', search);
  if (matchMedia('(max-width: 760px)').matches) document.querySelector('.navigation').open = false;
})();
