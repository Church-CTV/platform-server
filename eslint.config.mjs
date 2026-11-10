import js from '@eslint/js';
import globals from 'globals';

export default [
    // CJS source files
    {
        files: ['**/*.js'],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-console': 'off'
        }
    },
    // ESM test files
    {
        files: ['tests/**/*.mjs'],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node }
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-console': 'off'
        }
    },
    { ignores: ['node_modules/', 'output/', 'Videos/', 'uploads/', 'coverage/'] }
];
