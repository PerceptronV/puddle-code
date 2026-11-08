import type { HuddleValueSchema, HuddleValueType } from '../../api/huddle/contracts.js';
import { canonicalHuddleJson, isHuddleJson, type HuddleJson } from '../../api/huddle/values.js';

export interface HuddleValueIssue {
  path: string;
  message: string;
}

function matchesType(value: HuddleJson, type: HuddleValueType): boolean {
  if (type === 'null') return value === null;
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

/** Validate the supported JSON Schema subset after parsing the contract itself. */
export function validateHuddleValue(schema: HuddleValueSchema, value: unknown): HuddleValueIssue[] {
  if (!isHuddleJson(value)) return [{ path: '', message: 'Expected bounded JSON data' }];
  const issues: HuddleValueIssue[] = [];
  const visit = (rule: HuddleValueSchema, data: HuddleJson, path: string) => {
    if (issues.length >= 100) return;
    const issue = (message: string) => {
      issues.push({ path, message });
    };
    const types =
      rule.type === undefined ? undefined : Array.isArray(rule.type) ? rule.type : [rule.type];
    if (types && !types.some((type) => matchesType(data, type))) {
      issue(`Expected ${types.join(' or ')}`);
      return;
    }
    if (
      rule.enum &&
      !rule.enum.some((item) => canonicalHuddleJson(item) === canonicalHuddleJson(data))
    )
      issue('Value is not one of the declared choices');
    if (typeof data === 'number') {
      if (rule.minimum !== undefined && data < rule.minimum) issue(`Minimum is ${rule.minimum}`);
      if (rule.maximum !== undefined && data > rule.maximum) issue(`Maximum is ${rule.maximum}`);
    }
    if (typeof data === 'string') {
      const length = [...data].length;
      if (rule.minLength !== undefined && length < rule.minLength)
        issue(`Minimum length is ${rule.minLength}`);
      if (rule.maxLength !== undefined && length > rule.maxLength)
        issue(`Maximum length is ${rule.maxLength}`);
    }
    if (Array.isArray(data)) {
      if (rule.minItems !== undefined && data.length < rule.minItems)
        issue(`Minimum item count is ${rule.minItems}`);
      if (rule.maxItems !== undefined && data.length > rule.maxItems)
        issue(`Maximum item count is ${rule.maxItems}`);
      if (rule.items) data.forEach((item, index) => visit(rule.items!, item, `${path}/${index}`));
    } else if (data !== null && typeof data === 'object') {
      for (const key of rule.required ?? []) {
        if (!Object.hasOwn(data, key))
          issues.push({ path: `${path}/${key}`, message: 'Required property is missing' });
      }
      for (const [key, item] of Object.entries(data)) {
        const child = Object.hasOwn(rule.properties ?? {}, key) ? rule.properties![key] : undefined;
        const childPath = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        if (child) visit(child, item, childPath);
        else if (rule.additionalProperties === false)
          issues.push({ path: childPath, message: 'Unknown property' });
        if (issues.length >= 100) break;
      }
    }
  };
  visit(schema, value, '');
  return issues.slice(0, 100);
}

/** Conservative: unknown relationships are checked again when values cross a wire. */
export function huddlePortCompatibility(
  source: HuddleValueSchema,
  target: HuddleValueSchema,
): 'compatible' | 'incompatible' | 'unknown' {
  if (source.enum) {
    const valid = source.enum.filter((value) => validateHuddleValue(source, value).length === 0);
    if (!valid.length) return 'incompatible';
    const accepted = valid.filter((value) => validateHuddleValue(target, value).length === 0);
    if (accepted.length === valid.length) return 'compatible';
    if (accepted.length === 0) return 'incompatible';
  }
  if (
    Object.keys(target).length === 0 ||
    canonicalHuddleJson(source as HuddleJson) === canonicalHuddleJson(target as HuddleJson)
  )
    return 'compatible';
  if (source.type !== undefined && target.type !== undefined) {
    const from = Array.isArray(source.type) ? source.type : [source.type];
    const to = Array.isArray(target.type) ? target.type : [target.type];
    if (
      !from.some((a) =>
        to.some((b) => a === b || [a, b].every((t) => t === 'integer' || t === 'number')),
      )
    )
      return 'incompatible';
  }
  return 'unknown';
}
