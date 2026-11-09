import { isBuiltin, stripTypeScriptTypes } from 'node:module';
import { posix } from 'node:path';
import { parse, type AnyNode, type Program } from 'acorn';
import { huddleRelativePathSchema, type HuddleDiagnostic } from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../definitions/capture.js';

const nameOf = (node: AnyNode) =>
  node.type === 'Identifier' ? node.name : node.type === 'Literal' ? node.value : undefined;

/** Static inspection only. Never import an entry, invoke a getter or run project configuration. */
export function validateHuddleModules(snapshot: HuddleDefinitionSnapshot): HuddleDiagnostic[] {
  const diagnostics: HuddleDiagnostic[] = [];
  const parsed = new Map<string, Program | Error>();
  const checked = new Map<string, HuddleDiagnostic[]>();
  for (const node of snapshot.definition.nodes) {
    const component = snapshot.components[node.id];
    if (node.source.kind !== 'local' || !component?.entry) continue;
    const previous = checked.get(node.source.manifest);
    if (previous) {
      diagnostics.push(
        ...previous
          .slice(0, Math.max(0, 512 - diagnostics.length))
          .map((item) => ({ ...item, node: node.id })),
      );
      continue;
    }
    const firstDiagnostic = diagnostics.length;
    const directory = posix.dirname(node.source.manifest);
    const entry = posix.join(directory, component.entry);
    const paths = [
      posix.normalize(node.source.manifest),
      entry,
      ...component.dependencies.map((path) => posix.join(directory, path)),
    ];
    const closure = new Set(paths);
    const urls = new Set(
      [...closure].map(
        (path) => 'puddle-huddle:///' + path.split('/').map(encodeURIComponent).join('/'),
      ),
    );
    const add = (code: string, file: string, message: string, at?: AnyNode) => {
      if (diagnostics.length < 512)
        diagnostics.push({
          severity: 'error',
          code,
          node: node.id,
          path: `/files/${file}`,
          message:
            `${at?.loc ? `${at.loc.start.line}:${at.loc.start.column + 1}: ` : ''}${message}`.slice(
              0,
              4096,
            ),
        });
    };
    if (!/\.(?:m?ts|m?js)$/.test(entry))
      add('module_type', entry, 'Entry must be a JavaScript or erasable TypeScript module');
    if (closure.size !== paths.length)
      add(
        'module_closure',
        entry,
        'Manifest, entry and dependencies must name distinct captured files',
      );
    for (const file of closure) {
      if (file.endsWith('.json')) {
        try {
          JSON.parse(snapshot.files[file]!);
        } catch {
          add('module_json', file, 'Invalid captured JSON dependency');
        }
        continue;
      }
      if (!/\.(?:m?ts|m?js)$/.test(file)) {
        add('module_type', file, 'Workers support only .ts, .mts, .js, .mjs and JSON dependencies');
        continue;
      }
      if (!parsed.has(file)) {
        try {
          const source = snapshot.files[file];
          if (source === undefined) throw new Error('Module is missing from captured source');
          const javascript = /\.m?ts$/.test(file)
            ? stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: file })
            : source;
          parsed.set(
            file,
            parse(javascript, { ecmaVersion: 'latest', sourceType: 'module', locations: true }),
          );
        } catch (error) {
          parsed.set(file, error instanceof Error ? error : new Error(String(error)));
        }
      }
      const program = parsed.get(file)!;
      if (program instanceof Error) {
        add('module_syntax', file, program.message);
        continue;
      }
      const pending: AnyNode[] = [program];
      while (pending.length) {
        const item = pending.pop()!;
        const source =
          item.type === 'ImportDeclaration' ||
          item.type === 'ExportNamedDeclaration' ||
          item.type === 'ExportAllDeclaration' ||
          item.type === 'ImportExpression'
            ? item.source
            : undefined;
        if (source) {
          const specifier =
            source.type === 'Literal' && typeof source.value === 'string'
              ? source.value
              : undefined;
          if (!specifier)
            add(
              'module_import',
              file,
              'Use a literal import from the declared component closure',
              item,
            );
          else if (
            !['puddlang/huddle', 'puddlang', 'zod'].includes(specifier) &&
            !(specifier.startsWith('node:') && isBuiltin(specifier))
          ) {
            // Match URL resolution in installWorkerImports, including escaped path characters.
            const base = 'puddle-huddle:///' + file.split('/').map(encodeURIComponent).join('/');
            let allowed = false;
            try {
              allowed =
                (specifier.startsWith('./') || specifier.startsWith('../')) &&
                urls.has(new URL(specifier, base).href);
            } catch {
              /* Malformed specifiers cannot be captured imports. */
            }
            if (!allowed)
              add(
                'module_import',
                file,
                `Import is outside the captured component: ${specifier}`,
                item,
              );
          }
        }
        for (const value of Object.values(item)) {
          const values = Array.isArray(value) ? value : [value];
          for (const child of values)
            if (child && typeof child === 'object' && typeof child.type === 'string')
              pending.push(child as AnyNode);
        }
      }
      if (file !== entry) continue;
      try {
        checkWrapper(
          program,
          component.category === 'trigger' && !component.hostTrigger
            ? 'HuddleTrigger'
            : component.category === 'readout'
              ? 'HuddleReadout'
              : 'HuddleNode',
          directory,
          node.source.manifest,
          component.readout?.reconciliation === 'observe',
        );
      } catch (error) {
        add('module_contract', file, error instanceof Error ? error.message : String(error));
      }
    }
    checked.set(node.source.manifest, diagnostics.slice(firstDiagnostic));
  }
  return diagnostics;
}

function checkWrapper(
  program: Program,
  expected: string,
  directory: string,
  manifest: string,
  observe: boolean,
) {
  const symbols = new Map<string, AnyNode>();
  const imports = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration' && statement.source.value === 'puddlang/huddle')
      for (const specifier of statement.specifiers)
        if (specifier.type === 'ImportSpecifier')
          imports.set(specifier.local.name, String(nameOf(specifier.imported)));
        else if (specifier.type === 'ImportNamespaceSpecifier')
          imports.set(specifier.local.name, '*');
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const')
      for (const item of declaration.declarations)
        if (item.id.type === 'Identifier' && item.init) symbols.set(item.id.name, item.init);
    if (declaration?.type === 'FunctionDeclaration' && declaration.id)
      symbols.set(declaration.id.name, declaration);
  }
  const resolve = (value: AnyNode): AnyNode => {
    const seen = new Set<string>();
    while (value.type === 'Identifier' && symbols.has(value.name) && !seen.has(value.name)) {
      seen.add(value.name);
      value = symbols.get(value.name)!;
    }
    return value;
  };
  const exported = program.body.find((statement) => statement.type === 'ExportDefaultDeclaration');
  const call =
    exported?.type === 'ExportDefaultDeclaration' ? resolve(exported.declaration) : undefined;
  const required = `Export default ${expected}({ contract: './${posix.basename(manifest)}', ... }) using the puddlang/huddle import`;
  if (call?.type !== 'CallExpression' || call.arguments.length !== 1) throw new Error(required);
  const callee = call.callee;
  const wrapper =
    callee.type === 'Identifier'
      ? imports.get(callee.name)
      : callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          imports.get(callee.object.name) === '*'
        ? nameOf(callee.property)
        : undefined;
  if (wrapper !== expected) throw new Error(required);
  const declaration = resolve(call.arguments[0]!);
  if (declaration.type !== 'ObjectExpression')
    throw new Error('Wrapper settings must be a statically declared object');
  const properties = new Map<string, AnyNode>();
  for (const property of declaration.properties) {
    if (property.type !== 'Property' || property.computed || property.kind !== 'init')
      throw new Error('Wrapper settings cannot use spreads, computed keys or getters');
    const key = nameOf(property.key);
    if (typeof key !== 'string' || properties.has(key))
      throw new Error('Wrapper settings require unique named properties');
    properties.set(key, resolve(property.value));
  }
  const contract = properties.get('contract');
  if (contract?.type !== 'Literal' || typeof contract.value !== 'string')
    throw new Error('Wrapper contract must be a literal relative manifest path');
  const path = huddleRelativePathSchema.parse(contract.value);
  if (posix.join(directory, path) !== posix.normalize(manifest))
    throw new Error('Wrapper names a different component contract');
  if (expected === 'HuddleReadout' && !observe && properties.has('observe'))
    throw new Error('Readout observation support differs from its captured declaration');
  for (const method of [
    expected === 'HuddleTrigger' ? 'open' : expected === 'HuddleReadout' ? 'deliver' : 'run',
    ...(observe ? ['observe'] : []),
  ]) {
    const value = properties.get(method);
    if (
      !value ||
      !['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(value.type)
    )
      throw new Error(`${expected} requires a statically declared ${method} function`);
  }
}
