import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      'react/no-deprecated': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react/jsx-tag-spacing': ['error', { beforeSelfClosing: 'always' }],
      semi: ['error', 'never'],
      indent: ['error', 2],
      'no-mixed-spaces-and-tabs': 'error',
      quotes: ['error', 'single'],
      'space-before-function-paren': 'off',
      'no-empty': 'error',
      'no-duplicate-case': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'array-bracket-spacing': ['error', 'always', { singleValue: false, objectsInArrays: false }],
      'block-spacing': 'error',
      camelcase: ['error', { properties: 'always' }],
      'no-trailing-spaces': 'error',
      'no-self-compare': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'comma-dangle': ['error', 'never'],
      'template-curly-spacing': ['error', 'always'],
      'rest-spread-spacing': ['error', 'never'],
      'arrow-spacing': 'error',
      'template-tag-spacing': ['error', 'always'],
      'switch-colon-spacing': 'error',
      'space-infix-ops': 'error',
      'object-curly-spacing': [
        'error',
        'always',
        { arraysInObjects: false, objectsInObjects: false }
      ],
      'comma-spacing': ['error', { before: false, after: true }],
      'no-multi-spaces': ['error', { exceptions: { Property: false }, ignoreEOLComments: false }],
      'no-irregular-whitespace': ['error', { skipTemplates: true }],
      'no-extra-semi': 'error'
    }
  },
  eslintConfigPrettier
)
