// GNOME Shell extension lint rules. The Shell injects its own globals and
// loads ES modules from resource:// URIs, so the browser/node presets do not
// apply; this declares just what GJS provides.
export default [
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                globalThis: 'readonly',
                imports: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                ARGV: 'readonly',
                pkg: 'readonly',
                _: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-undef': 'error',
            'no-redeclare': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-class-members': 'error',
            'no-unreachable': 'error',
            'no-constant-condition': 'error',
            'no-empty': ['error', {allowEmptyCatch: true}],
            'no-var': 'error',
            'prefer-const': 'error',
            eqeqeq: ['error', 'smart'],
            semi: ['error', 'always'],
        },
    },
    {
        ignores: ['node_modules/**', 'helpers/**'],
    },
];
