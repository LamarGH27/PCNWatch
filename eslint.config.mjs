import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/sdk',
              message: 'Anthropic must only be reached through src/server/ai/*. Never from client or shared code.',
            },
          ],
        },
      ],
    },
  },
  {
    // The one place the SDK may be imported. The rule above exists to keep the
    // model behind this boundary — client code, shared code and route handlers
    // must go through `runAiJob`, which redacts the input, validates the
    // response and logs a fingerprint rather than the document. Banning the
    // import here too would ban it everywhere, which is not what the rule means.
    files: ['src/server/ai/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];

export default config;
