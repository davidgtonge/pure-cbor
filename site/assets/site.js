// pure-cbor documentation site: syntax highlighting, the table of contents,
// and chart tooltips. Plain script, no dependencies; the pages read fine
// without it.

(function () {
  'use strict';

  // ---------------------------------------------------------------- highlighting

  const TYPESCRIPT_KEYWORDS = new Set([
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
    'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if',
    'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'readonly', 'return',
    'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
  ]);

  // One alternation, tried left to right at each position. The trim marker
  // `// …` is matched before ordinary comments so it can be styled apart.
  const TYPESCRIPT_PATTERN = new RegExp([
    '(?<trim>// …)',
    '(?<comment>//[^\\n]*|/\\*[\\s\\S]*?\\*/)',
    '(?<string>\'(?:\\\\.|[^\'\\\\\\n])*\'|"(?:\\\\.|[^"\\\\\\n])*"|`(?:\\\\.|[^`\\\\])*`)',
    '(?<number>\\b0x[0-9a-fA-F_]+n?\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?n?\\b)',
    '(?<word>[A-Za-z_$][\\w$]*)',
  ].join('|'), 'g');

  const SHELL_PATTERN = /(?<comment>#[^\n]*)|(?<string>'[^'\n]*'|"[^"\n]*")|(?<command>^(?:npm|node|python3|cd|git)\b)/gm;

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function wrapToken(className, text) {
    return '<span class="' + className + '">' + escapeHtml(text) + '</span>';
  }

  function classifyWord(word, sourceText, wordEnd) {
    if (TYPESCRIPT_KEYWORDS.has(word)) return 'token-keyword';
    if (sourceText[wordEnd] === '(' || sourceText.startsWith('<', wordEnd) && /^<[\w\s,<>[\]|]*>\(/.test(sourceText.slice(wordEnd, wordEnd + 60))) {
      return 'token-function';
    }
    if (/^[A-Z]/.test(word)) return 'token-type';
    return '';
  }

  function highlightWith(pattern, sourceText, classifyMatch) {
    let html = '';
    let lastIndex = 0;
    pattern.lastIndex = 0;
    for (const match of sourceText.matchAll(pattern)) {
      html += escapeHtml(sourceText.slice(lastIndex, match.index));
      const matchedText = match[0];
      const className = classifyMatch(match.groups, matchedText, match.index + matchedText.length);
      html += className ? wrapToken(className, matchedText) : escapeHtml(matchedText);
      lastIndex = match.index + matchedText.length;
    }
    return html + escapeHtml(sourceText.slice(lastIndex));
  }

  function highlightTypeScript(sourceText) {
    return highlightWith(TYPESCRIPT_PATTERN, sourceText, function (groups, matchedText, matchEnd) {
      if (groups.trim) return 'token-trim';
      if (groups.comment) return 'token-comment';
      if (groups.string) return 'token-string';
      if (groups.number) return 'token-number';
      return classifyWord(matchedText, sourceText, matchEnd);
    });
  }

  function highlightShell(sourceText) {
    return highlightWith(SHELL_PATTERN, sourceText, function (groups) {
      if (groups.comment) return 'token-comment';
      if (groups.string) return 'token-string';
      if (groups.command) return 'token-command';
      return '';
    });
  }

  function highlightCodeBlocks() {
    for (const codeElement of document.querySelectorAll('pre > code[class*="language-"]')) {
      const sourceText = codeElement.textContent;
      if (codeElement.classList.contains('language-ts')) codeElement.innerHTML = highlightTypeScript(sourceText);
      else if (codeElement.classList.contains('language-sh')) codeElement.innerHTML = highlightShell(sourceText);
    }
  }

  // Scrollable code blocks and diagrams must be reachable by keyboard.
  function makeScrollersFocusable() {
    for (const scroller of document.querySelectorAll('pre, .diagram-scroll, .table-wrap')) {
      if (!scroller.hasAttribute('tabindex')) scroller.setAttribute('tabindex', '0');
    }
  }

  // ---------------------------------------------------------------- table of contents

  function buildTocList(headings) {
    const list = document.createElement('ol');
    list.className = 'toc-list';
    for (const heading of headings) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = '#' + heading.id;
      link.textContent = heading.dataset.tocLabel || heading.textContent;
      item.appendChild(link);
      list.appendChild(item);
    }
    return list;
  }

  function highlightCurrentSection(headings, tocLinks) {
    let currentIndex = 0;
    const threshold = window.innerHeight * 0.3;
    headings.forEach(function (heading, headingIndex) {
      if (heading.getBoundingClientRect().top < threshold) currentIndex = headingIndex;
    });
    tocLinks.forEach(function (link) {
      const isCurrent = link.getAttribute('href') === '#' + headings[currentIndex].id;
      if (isCurrent) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  function buildTableOfContents() {
    const headings = Array.from(document.querySelectorAll('.article h2[id]'));
    const containers = document.querySelectorAll('[data-toc]');
    if (headings.length === 0 || containers.length === 0) {
      for (const container of document.querySelectorAll('.toc-mobile, .toc-aside')) container.hidden = true;
      return;
    }
    for (const container of containers) container.appendChild(buildTocList(headings));
    const asideLinks = Array.from(document.querySelectorAll('.toc-aside .toc-list a'));
    let scheduled = false;
    const update = function () {
      scheduled = false;
      highlightCurrentSection(headings, asideLinks);
    };
    window.addEventListener('scroll', function () {
      if (!scheduled) {
        scheduled = true;
        window.requestAnimationFrame(update);
      }
    }, { passive: true });
    update();
    // Close the mobile contents after choosing a section.
    for (const mobileLink of document.querySelectorAll('.toc-mobile a')) {
      mobileLink.addEventListener('click', function () {
        mobileLink.closest('details').open = false;
      });
    }
  }

  // ---------------------------------------------------------------- chart tooltips

  function positionTooltip(tooltip, chartBody, mark) {
    const bodyBox = chartBody.getBoundingClientRect();
    const markBox = mark.getBoundingClientRect();
    const left = Math.min(markBox.right - bodyBox.left + 8, bodyBox.width - tooltip.offsetWidth - 4);
    const top = markBox.top - bodyBox.top + markBox.height / 2 - tooltip.offsetHeight / 2;
    tooltip.style.left = Math.max(4, left) + 'px';
    tooltip.style.top = Math.max(0, top) + 'px';
  }

  function attachChartTooltips() {
    for (const chartBody of document.querySelectorAll('.chart-body')) {
      const tooltip = document.createElement('div');
      tooltip.className = 'chart-tooltip';
      tooltip.setAttribute('role', 'status');
      tooltip.hidden = true;
      chartBody.appendChild(tooltip);
      const show = function (event) {
        const mark = event.currentTarget;
        tooltip.textContent = mark.dataset.tooltip;
        tooltip.hidden = false;
        positionTooltip(tooltip, chartBody, mark);
      };
      const hide = function () { tooltip.hidden = true; };
      for (const mark of chartBody.querySelectorAll('.chart-mark')) {
        mark.addEventListener('pointerenter', show);
        mark.addEventListener('focus', show);
        mark.addEventListener('pointerleave', hide);
        mark.addEventListener('blur', hide);
      }
    }
  }

  // ---------------------------------------------------------------- start

  function start() {
    highlightCodeBlocks();
    makeScrollersFocusable();
    buildTableOfContents();
    attachChartTooltips();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
