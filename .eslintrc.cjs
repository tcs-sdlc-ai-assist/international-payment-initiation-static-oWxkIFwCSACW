module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
  ],
  plugins: ['react', 'react-hooks', 'jsx-a11y', 'react-refresh'],
  rules: {
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    'react/prop-types': 'error',
  },
  overrides: [
    {
      files: ['**/*.test.{js,jsx}', 'src/test/**/*.{js,jsx}'],
      env: {
        'vitest/globals': true,
      },
      rules: {
        'no-console': 'off',
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.cjs'],
};