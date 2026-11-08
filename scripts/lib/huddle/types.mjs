import ts from 'typescript';
import { format } from 'prettier';
import { resolve } from 'node:path';

/** Generate a standalone declaration from the actual SDK, not a second handwritten contract. */
export async function huddleAuthoringTypes(root) {
  const paths = {
    values: 'packages/shared/src/api/huddle/values.ts',
    events: 'packages/shared/src/api/huddle/events.ts',
    agents: 'packages/shared/src/api/agents/puddlang.ts',
    context: 'packages/daemon/src/puddlang/huddle/context.ts',
    node: 'packages/daemon/src/puddlang/huddle/node.ts',
    trigger: 'packages/daemon/src/puddlang/huddle/trigger.ts',
    readout: 'packages/daemon/src/puddlang/huddle/readout.ts',
    client: 'packages/daemon/src/puddlang/client.ts',
  };
  const program = ts.createProgram(
    Object.values(paths).map((path) => resolve(root, path)),
    {
      strict: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
    },
  );
  const checker = program.getTypeChecker();
  const source = (key) => program.getSourceFile(resolve(root, paths[key]));
  const declaration = (key, name) => {
    const found = source(key)?.statements.find((node) => node.name?.text === name);
    if (!found) throw new Error(`Missing SDK declaration: ${key}/${name}`);
    return found;
  };
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;
  const local = (text) => {
    const result = text
      .replace(/import\("[^"]*\/huddle\/values"\)\.HuddleJson/g, 'HuddleJson')
      .replace(/import\(['"]\.\.\/client\.js['"]\)\.PuddlangClient/g, 'PuddlangClient');
    if (/import\s*\(/.test(result)) throw new Error(`Unresolved SDK type dependency: ${result}`);
    return result;
  };
  const alias = (key, name) => {
    const node = declaration(key, name);
    return `export type ${name} = ${local(checker.typeToString(checker.getTypeAtLocation(node), node, flags))};`;
  };
  const parts = [
    declaration('values', 'HuddleJson').getText(),
    ...[
      'HuddleTriggerEmission',
      'HuddleEvent',
      'HuddleDelivery',
      'HuddleDeliveryResult',
      'HuddleTriggerHealth',
    ].map((name) => alias('events', name)),
    ...['PuddlangSpawn', 'PuddlangHandle'].map((name) => alias('agents', name)),
    ...source('context')
      .statements.filter(
        (node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node),
      )
      .map((node) => local(node.getText())),
    declaration('node', 'HuddleNodeModule').getText(),
  ];
  const agent = declaration('client', 'PuddlangAgent');
  const methods = agent.members.filter((node) => ts.isMethodDeclaration(node) && !node.body);
  // ask has public overloads; stop has one implementation signature. Private transport stays private.
  const stop = agent.members.find((node) => node.name?.getText() === 'stop');
  const signatures = [...methods, stop].map(
    (node) =>
      `${node.name.getText()}${checker.signatureToString(checker.getSignatureFromDeclaration(node), node, flags)};`,
  );
  parts.push(
    `export interface PuddlangAgent { readonly handle: PuddlangHandle; ${signatures.join('\n')} }`,
  );
  parts.push(alias('client', 'PuddlangClient'));
  for (const [key, name] of [
    ['node', 'HuddleNode'],
    ['trigger', 'HuddleTrigger'],
    ['readout', 'HuddleReadout'],
  ]) {
    const node = declaration(key, name);
    parts.push(
      `export function ${name}${checker.signatureToString(checker.getSignatureFromDeclaration(node), node, flags)};`,
    );
  }
  parts.push(
    'export const spawn: PuddlangClient["spawn"]; export const attach: PuddlangClient["attach"];',
  );
  return format(
    `// Generated from the pinned SDK. Types only; the huddle worker supplies runtime imports.\n// Resolve zod 4 as a development dependency when type-checking these declarations.\ndeclare module 'puddlang/huddle' { import type { z } from 'zod';\n${parts.join('\n')}\n}\ndeclare module 'puddlang' { export { spawn, attach } from 'puddlang/huddle'; }\n`,
    { parser: 'typescript' },
  );
}
