import { findMatches } from './find-matches';
import type { FindDirection, FindOptions, FindResult } from './find-types';

let controllerId = 0;

interface TextNodeOffset {
  node: Text;
  start: number;
  end: number;
}

function searchableText(root: HTMLElement): { text: string; nodes: TextNodeOffset[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !node.textContent ||
        parent?.closest('script, style, noscript, [hidden], [aria-hidden="true"]')
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: TextNodeOffset[] = [];
  let text = '';
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const value = node.textContent ?? '';
    const start = text.length;
    text += value;
    nodes.push({ node: node as Text, start, end: text.length });
  }
  return { text, nodes };
}

function rangeFor(match: { start: number; end: number }, nodes: TextNodeOffset[]): Range | null {
  const first = nodes.find((entry) => entry.end > match.start);
  const last = nodes.findLast((entry) => entry.start < match.end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, match.start - first.start);
  range.setEnd(last.node, match.end - last.start);
  return range;
}

/** Search/highlight one inline rendered document without mutating its DOM. */
export class DomFindController {
  private readonly matchName = `puddle-find-${++controllerId}-match`;
  private readonly activeName = `puddle-find-${controllerId}-active`;
  private readonly style: HTMLStyleElement;
  private signature = '';
  private ranges: Range[] = [];
  private index = -1;
  private limited = false;

  constructor(private readonly root: HTMLElement) {
    this.style = document.createElement('style');
    this.style.textContent = `
      ::highlight(${this.matchName}) { background: var(--selection); }
      ::highlight(${this.activeName}) { background: var(--accent); color: var(--action-ink); }
    `;
    document.head.appendChild(this.style);
  }

  find(query: string, options: FindOptions, direction: FindDirection): FindResult {
    const signature = JSON.stringify([query, options]);
    if (signature !== this.signature || direction === 'reset') {
      this.signature = signature;
      const content = searchableText(this.root);
      const found = findMatches(content.text, query, options);
      this.ranges = found.matches
        .map((match) => rangeFor(match, content.nodes))
        .filter((range): range is Range => range !== null);
      this.limited = found.limited;
      this.index = this.ranges.length > 0 ? 0 : -1;
      if (found.invalid) {
        this.clearHighlights();
        return { index: -1, count: 0, invalid: true };
      }
    } else if (this.ranges.length > 0) {
      this.index =
        direction === 'previous'
          ? (this.index - 1 + this.ranges.length) % this.ranges.length
          : (this.index + 1) % this.ranges.length;
    }

    this.paint();
    return { index: this.index, count: this.ranges.length, limited: this.limited };
  }

  clear(): void {
    this.signature = '';
    this.ranges = [];
    this.index = -1;
    this.limited = false;
    this.clearHighlights();
  }

  dispose(): void {
    this.clear();
    this.style.remove();
  }

  private clearHighlights(): void {
    CSS.highlights.delete(this.matchName);
    CSS.highlights.delete(this.activeName);
  }

  private paint(): void {
    this.clearHighlights();
    if (this.ranges.length === 0) return;
    CSS.highlights.set(this.matchName, new Highlight(...this.ranges));
    const active = this.ranges[this.index];
    if (!active) return;
    CSS.highlights.set(this.activeName, new Highlight(active));
    const element = active.startContainer.parentElement;
    element?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}
