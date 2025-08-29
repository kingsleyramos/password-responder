// eslint.config.mjs
import js from '@eslint/js';
import globals from 'globals';
import {defineConfig} from 'eslint/config';

export default defineConfig([
    {
        files: ['**/*.{js,mjs,cjs}'],
        // Use ESLint's recommended JS rules
        ...js.configs.recommended,
        languageOptions: {
            // Enable Node globals like `process`, `__dirname`, etc.
            globals: {
                ...globals.node,
            },
            sourceType: 'module',
        },
    },
]);
