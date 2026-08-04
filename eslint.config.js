// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/dist-release/**', '**/tsc-out/**', '**/node_modules/**', 'docs/**'],
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // ignoreRestSiblings permits the `const { secret, ...rest } = row` omit idiom.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Rules of Hooks, on every React file. A hook called after a component's
    // loading gate returns early changes the hook COUNT between renders, and
    // React tears the whole tree down with a blank page the moment the gate
    // flips — exactly how v0.0.22 shipped a workspace that never opened. Only
    // this rule is on: `exhaustive-deps` and the compiler rules would drown a
    // codebase whose effects deliberately narrow their deps (each documented
    // at its site), and a noisy rule is a rule that gets ignored.
    files: ['packages/*/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
);
