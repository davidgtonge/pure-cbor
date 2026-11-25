// pure-cbor documentation site: syntax highlighting, the chapter and step
// tracking, the scroll-linked trace panels and chart tooltips. Plain script,
// no dependencies; the page reads fine
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

  // ---------------------------------------------------------------- scroll position: chapters, steps, progress

  // The last element whose top has passed the reading line, or the first one.
  function currentByTop(elements, readingLine) {
    let current = elements[0];
    for (const element of elements) {
      if (element.getBoundingClientRect().top <= readingLine) current = element;
      else break;
    }
    return current;
  }

  function setCurrent(links, isCurrent) {
    for (const link of links) {
      if (isCurrent(link)) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  }

  function trackChapters() {
    const chapters = Array.from(document.querySelectorAll('.chapter[id]'));
    const headings = Array.from(document.querySelectorAll('.chapter h3[id]'));
    const navLinks = Array.from(document.querySelectorAll('.chapter-nav a'));
    const tocChapters = Array.from(document.querySelectorAll('.toc-chapters > li'));
    const tocStepLinks = Array.from(document.querySelectorAll('.toc-steps a'));
    const progress = document.querySelector('.reading-progress');
    if (chapters.length === 0) return;

    const update = function () {
      const readingLine = window.innerHeight * 0.35;
      const chapter = currentByTop(chapters, readingLine);
      const chapterHash = '#' + chapter.id;
      setCurrent(navLinks, function (link) { return link.getAttribute('href') === chapterHash; });
      for (const item of tocChapters) item.classList.toggle('is-current', item.dataset.chapter === chapter.id);
      const headingsInChapter = headings.filter(function (heading) { return chapter.contains(heading); });
      const heading = headingsInChapter.length > 0 && headingsInChapter[0].getBoundingClientRect().top <= readingLine
        ? currentByTop(headingsInChapter, readingLine)
        : null;
      setCurrent(tocStepLinks, function (link) { return heading !== null && link.getAttribute('href') === '#' + heading.id; });
      if (progress) {
        const scrollable = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.setProperty('--progress', scrollable > 0 ? String(Math.min(1, window.scrollY / scrollable)) : '0');
      }
    };
    onScrollFrame(update);
  }

  function onScrollFrame(update) {
    let scheduled = false;
    const schedule = function () {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(function () {
        scheduled = false;
        update();
      });
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    update();
  }

  // ---------------------------------------------------------------- the trace panels beside encode and decode

  // "1-3 5" -> [1, 2, 3, 5]
  function parseByteRanges(text) {
    const indexes = [];
    for (const range of (text || '').split(/\s+/).filter(Boolean)) {
      const [first, last] = range.split('-').map(Number);
      for (let index = first; index <= (last === undefined ? first : last); index++) indexes.push(index);
    }
    return indexes;
  }

  function buildTraceBytes(container) {
    const hexBytes = container.dataset.traceBytes.split(' ');
    const byteCells = [];
    const groups = [];
    for (const groupSpec of container.dataset.traceGroups.split('|')) {
      const separator = groupSpec.indexOf(':');
      const indexes = parseByteRanges(groupSpec.slice(0, separator));
      const group = document.createElement('span');
      group.className = 'trace-group';
      const bytesRow = document.createElement('span');
      bytesRow.className = 'trace-group-bytes';
      for (const index of indexes) {
        const cell = document.createElement('span');
        cell.className = 'trace-byte';
        cell.textContent = hexBytes[index];
        byteCells[index] = cell;
        bytesRow.appendChild(cell);
      }
      const label = document.createElement('span');
      label.className = 'trace-group-label';
      label.textContent = groupSpec.slice(separator + 1);
      group.append(bytesRow, label);
      container.appendChild(group);
      groups.push({ element: group, indexes: indexes });
    }
    return { byteCells: byteCells, groups: groups };
  }

  function showStep(trace, parts, step) {
    const activeNodes = new Set((step.dataset.nodes || '').split(/\s+/).filter(Boolean));
    for (const node of trace.querySelectorAll('[data-node]')) node.classList.toggle('is-active', activeNodes.has(node.dataset.node));
    const activeBytes = new Set(parseByteRanges(step.dataset.bytes));
    parts.byteCells.forEach(function (cell, index) { cell.classList.toggle('is-active', activeBytes.has(index)); });
    for (const group of parts.groups) {
      group.element.classList.toggle('is-active', group.indexes.some(function (index) { return activeBytes.has(index); }));
    }
    const activeOutputs = new Set((step.dataset.out || '').split(/\s+/).filter(Boolean));
    for (const output of trace.querySelectorAll('[data-out]')) output.classList.toggle('is-active', activeOutputs.has(output.dataset.out));
    const note = trace.querySelector('[data-trace-note]');
    if (note) note.textContent = step.dataset.note || '';
  }

  function setUpScrolly(scrolly) {
    const steps = Array.from(scrolly.querySelectorAll('.step'));
    const trace = scrolly.querySelector('[data-trace]');
    if (steps.length === 0 || !trace) return;
    const parts = buildTraceBytes(trace.querySelector('[data-trace-bytes]'));
    let shown = null;
    onScrollFrame(function () {
      const step = currentByTop(steps, window.innerHeight * 0.45);
      if (step === shown) return;
      if (shown) shown.classList.remove('is-current');
      step.classList.add('is-current');
      shown = step;
      showStep(trace, parts, step);
    });
    // Selecting a function in the panel scrolls to the first step about it.
    for (const node of trace.querySelectorAll('[data-node]')) {
      const target = steps.find(function (step) { return (step.dataset.nodes || '').split(/\s+/).includes(node.dataset.node); });
      if (!target) continue;
      node.setAttribute('role', 'link');
      node.setAttribute('tabindex', '0');
      const heading = target.querySelector('h3');
      node.setAttribute('aria-label', 'Go to: ' + (heading ? heading.textContent : node.textContent));
      const go = function () { target.scrollIntoView({ block: 'start' }); };
      node.addEventListener('click', go);
      node.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go(); }
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
    document.documentElement.classList.add('js');
    trackChapters();
    for (const scrolly of document.querySelectorAll('.scrolly')) setUpScrolly(scrolly);
    attachChartTooltips();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
