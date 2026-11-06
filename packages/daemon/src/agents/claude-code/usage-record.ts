import { parser, type Token } from 'stream-json/parser.js';
import type { AgentUsage } from '../adapter.js';

export const emptyUsage = (): AgentUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  message_count: 0,
});

const fields = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

export function addUsage(total: AgentUsage, value: AgentUsage): void {
  for (const field of fields) total[field] += value[field];
  total.message_count += value.message_count;
}

export function recordUsage(value: unknown): AgentUsage {
  const result = emptyUsage();
  if (
    !value ||
    typeof value !== 'object' ||
    !('type' in value) ||
    value.type !== 'assistant' ||
    !('message' in value) ||
    !value.message ||
    typeof value.message !== 'object' ||
    !('usage' in value.message) ||
    !value.message.usage ||
    typeof value.message.usage !== 'object'
  )
    return result;
  result.message_count = 1;
  for (const field of fields) {
    const count = (value.message.usage as Record<string, unknown>)[field];
    if (typeof count === 'number' && Number.isFinite(count)) result[field] = count;
  }
  return result;
}

/**
 * Large records can contain huge tool payloads. The tokenizer validates JSON,
 * while this projection retains only bounded keys and usage scalars. Small
 * records take JSON.parse's faster path in the file reader.
 */
export class UsageRecord {
  private readonly parser = parser.asStream({ packValues: false });
  private readonly stack: Array<{ kind: 'object' | 'array'; path: string; key: string }> = [];
  private scalar: 'key' | 'string' | 'number' | null = null;
  private text = '';
  private failed = false;
  private type: string | undefined;
  private usage: AgentUsage | undefined;

  constructor() {
    this.parser.on('data', (token: Token) => this.token(token));
    this.parser.on('error', () => {
      this.failed = true;
    });
  }

  async write(text: string): Promise<void> {
    if (this.failed) return;
    await new Promise<void>((resolve) => {
      this.parser.write(text, () => resolve());
    });
  }

  async finish(): Promise<AgentUsage> {
    if (!this.failed)
      await new Promise<void>((resolve) => {
        this.parser.once('close', resolve);
        this.parser.end();
      });
    return !this.failed && this.type === 'assistant' && this.usage ? this.usage : emptyUsage();
  }

  dispose(): void {
    this.parser.destroy();
  }

  private path(): string {
    const parent = this.stack.at(-1);
    if (!parent) return '';
    if (parent.kind === 'array' || parent.path === '!' || parent.key.includes('.')) return '!';
    const path = parent.path ? `${parent.path}.${parent.key}` : parent.key;
    return path.length <= 128 ? path : '!';
  }

  private token(token: Token): void {
    if (this.failed) return;
    if (token.name === 'startKey' || token.name === 'startString' || token.name === 'startNumber') {
      this.scalar =
        token.name === 'startKey' ? 'key' : token.name === 'startString' ? 'string' : 'number';
      this.text = '';
    } else if (token.name === 'stringChunk' || token.name === 'numberChunk') {
      // Values longer than this cannot be a field/type/token count we consume.
      if (this.text.length <= 128) this.text += token.value.slice(0, 129 - this.text.length);
    } else if (token.name === 'endKey') {
      if (this.stack.length) this.stack.at(-1)!.key = this.text.length <= 128 ? this.text : '!';
      this.scalar = null;
    } else if (token.name === 'endString' || token.name === 'endNumber') {
      const path = this.path();
      if (path === 'type') this.type = this.scalar === 'string' ? this.text : undefined;
      if (path === 'message' || path === 'message.usage') this.usage = undefined;
      if (this.usage && path.startsWith('message.usage.')) {
        const field = fields.find((field) => path === `message.usage.${field}`);
        const value = Number(this.text);
        if (field)
          this.usage[field] = this.scalar === 'number' && Number.isFinite(value) ? value : 0;
      }
      this.scalar = null;
    } else if (token.name === 'startObject' || token.name === 'startArray') {
      const path = this.path();
      // Bound nesting even for malformed/non-native data.
      if (this.stack.length >= 128) {
        this.failed = true;
        this.parser.destroy();
        return;
      }
      if (path === 'type') this.type = undefined;
      if (path === 'message') this.usage = undefined;
      if (path === 'message.usage') {
        this.usage = emptyUsage();
        this.usage.message_count = 1;
      }
      const field = fields.find((field) => path === `message.usage.${field}`);
      if (field && this.usage) this.usage[field] = 0;
      this.stack.push({ kind: token.name === 'startObject' ? 'object' : 'array', path, key: '' });
    } else if (token.name === 'endObject' || token.name === 'endArray') {
      this.stack.pop();
    } else if (
      token.name === 'nullValue' ||
      token.name === 'trueValue' ||
      token.name === 'falseValue'
    ) {
      const path = this.path();
      if (path === 'type') this.type = undefined;
      if (path === 'message' || path === 'message.usage') this.usage = undefined;
      const field = fields.find((field) => path === `message.usage.${field}`);
      if (field && this.usage) this.usage[field] = 0;
    }
  }
}
