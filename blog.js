document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('page-content');
  if (!container) return;

  const slug = new URLSearchParams(window.location.search).get('post');

  let posts;
  try {
    const res = await fetch('./assets/blog-posts/index.json');
    posts = await res.json();
  } catch (err) {
    container.textContent = 'Unable to load blog posts.';
    return;
  }

  if (slug) {
    const post = posts.find((p) => p.slug === slug);
    if (!post) {
      container.textContent = 'Post not found.';
      return;
    }
    await renderPost(container, post);
  } else {
    renderPostList(container, posts);
  }
});

async function renderPost(container, post) {
  let markdown;
  try {
    const res = await fetch(`./assets/blog-posts/${post.slug}.md`);
    markdown = await res.text();
  } catch (err) {
    container.textContent = 'Unable to load post.';
    return;
  }

  const converter = new Markdown.Converter();

  const article = document.createElement('article');
  article.className = 'blog-post blog-post-full';

  const back = document.createElement('a');
  back.href = './blog.html';
  back.className = 'blog-back-link';
  back.textContent = '\u2190 Back to all posts';
  article.appendChild(back);

  const heading = document.createElement('h1');
  heading.className = 'blog-post-title';
  heading.textContent = post.title;
  article.appendChild(heading);

  if (post.date) {
    const time = document.createElement('time');
    time.className = 'blog-post-date';
    time.dateTime = post.date;
    time.textContent = post.date;
    article.appendChild(time);
  }

  const body = document.createElement('div');
  body.className = 'blog-post-body';
  const { text: textNoFences, blocks: codeBlocks } = extractFencedCodeBlocks(markdown.trim());
  const { text, blocks: tableBlocks } = extractTables(textNoFences, converter);
  let html = converter.makeHtml(text);
  codeBlocks.forEach((block, index) => {
    html = html.replace(`<p>CODEBLOCK_PLACEHOLDER_${index}</p>`, block);
  });
  tableBlocks.forEach((block, index) => {
    html = html.replace(`<p>TABLE_PLACEHOLDER_${index}</p>`, block);
  });
  body.innerHTML = html;
  article.appendChild(body);

  container.appendChild(article);

  if (window.hljs) {
    body.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
  }
}

// Pagedown only recognizes 4-space-indented code blocks and has no concept of
// fenced ``` blocks, so we pull them out before conversion and swap in their
// rendered <pre><code> HTML afterward, rather than relying on Pagedown's
// raw-HTML passthrough (which requires exact blank-line/positioning that
// isn't always present in real posts).
function extractFencedCodeBlocks(markdown) {
  // Normalize CRLF/CR line endings first: the fence regex below matches a
  // literal \n, and files saved with Windows line endings otherwise slip
  // through unmatched and fall back to Pagedown's broken fence handling.
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const blocks = [];
  const text = normalized.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    const index = blocks.length;
    const languageClass = lang ? `language-${lang}` : 'language-plaintext';
    const trimmedCode = code.replace(/\n$/, '');
    blocks.push(`<pre><code class="${languageClass}">${escapeHtml(trimmedCode)}</code></pre>`);
    return `\n\nCODEBLOCK_PLACEHOLDER_${index}\n\n`;
  });
  return { text, blocks };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Pagedown also has no concept of GFM pipe tables, so a header row + a
// separator row (e.g. "| --- | --- |") of dashes/colons marks the start of a
// table, which we pull out, build into an HTML <table>, and swap back in
// after conversion, same as the fenced-code-block placeholders above.
function extractTables(markdown, converter) {
  const lines = markdown.split('\n');
  const outputLines = [];
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    if (isTableRow(lines[i]) && lines[i + 1] && isTableSeparatorRow(lines[i + 1])) {
      const headerCells = splitTableRow(lines[i]);
      const alignments = parseTableAlignments(lines[i + 1]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }

      const index = blocks.length;
      blocks.push(buildTableHtml(headerCells, alignments, rows, converter));
      outputLines.push('', `TABLE_PLACEHOLDER_${index}`, '');
      i = j;
    } else {
      outputLines.push(lines[i]);
      i++;
    }
  }

  return { text: outputLines.join('\n'), blocks };
}

function isTableRow(line) {
  return typeof line === 'string' && line.includes('|') && line.trim() !== '';
}

function isTableSeparatorRow(line) {
  if (!isTableRow(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function parseTableAlignments(separatorLine) {
  return splitTableRow(separatorLine).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function buildTableHtml(headerCells, alignments, rows, converter) {
  const cellStyle = (align) => (align ? ` style="text-align:${align}"` : '');
  const renderCell = (text) => renderInlineMarkdown(text, converter);

  const thead = `<thead><tr>${headerCells
    .map((cell, i) => `<th${cellStyle(alignments[i])}>${renderCell(cell)}</th>`)
    .join('')}</tr></thead>`;

  const tbody = `<tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((cell, i) => `<td${cellStyle(alignments[i])}>${renderCell(cell)}</td>`).join('')}</tr>`
    )
    .join('')}</tbody>`;

  return `<table class="blog-table">${thead}${tbody}</table>`;
}

function renderInlineMarkdown(text, converter) {
  const html = converter.makeHtml(text);
  return html.replace(/^<p>([\s\S]*)<\/p>\s*$/, '$1').trim();
}

function renderPostList(container, posts) {
  const list = document.createElement('ul');
  list.className = 'blog-list';

  posts
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .forEach((post) => {
      const item = document.createElement('li');
      item.className = 'blog-list-item';

      const link = document.createElement('a');
      link.href = `./blog.html?post=${encodeURIComponent(post.slug)}`;
      link.className = 'blog-list-title';
      link.textContent = post.title;
      item.appendChild(link);

      if (post.date) {
        const time = document.createElement('time');
        time.className = 'blog-post-date';
        time.dateTime = post.date;
        time.textContent = post.date;
        item.appendChild(time);
      }

      if (post.preview) {
        const preview = document.createElement('p');
        preview.className = 'blog-list-preview';
        preview.textContent = post.preview;
        item.appendChild(preview);
      }

      list.appendChild(item);
    });

  container.appendChild(list);
}
