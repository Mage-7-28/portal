import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import typescriptEslint from '@typescript-eslint/eslint-plugin'
import typescriptParser from '@typescript-eslint/parser'
import importPlugin from 'eslint-plugin-import'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      parser: typescriptParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        browser: true,
        node: true
      }
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      '@typescript-eslint': typescriptEslint,
      import: importPlugin,
      'react-refresh': reactRefresh
    },
    rules: {
      // eslint中文配置文档: `https://zh-hans.eslint.org/docs/latest/rules/`
      'react/no-deprecated': 'off', //  忽略提示react弃用方法
      'react-refresh/only-export-components': [ 'warn', { 'allowConstantExport': true }], // 允许通过常量导出组件
      'semi': [ 'error', 'never' ], // 禁止尾部使用分号“ ; ”
      'indent': [ 'error', 2 ], // 缩进2格
      'no-mixed-spaces-and-tabs': 'error', // 不能空格与tab混用
      'quotes': [ 'error', 'single' ], // 使用单引号
      'space-before-function-paren': 'off', // 函数括号前必须带空格
      'no-empty': 'error', // 禁止空块语句
      'no-duplicate-case': 'error', // 禁止重复 case 标签
      'no-dupe-keys': 'error', // 禁止在对象字面量中出现重复的键
      'no-dupe-args': 'error', // 禁止在 function 定义中出现重复的参数
      'array-bracket-spacing': [ 'error', 'always', { 'singleValue': false, 'objectsInArrays': false }], // 强制在数组括号内使用空格
      'block-spacing': 'error', // 强制在代码块中开括号前和闭括号后有空格
      'camelcase': [ 0, { 'properties': 'always' }], // 驼峰命名
      'no-trailing-spaces': 'error', // 禁止行尾空格
      // "quote-props": ["error", "as-needed"], // 要求对象字面量属性名称使用引号
      'no-self-compare': 'error', // 禁止自身比较
      'eqeqeq': [ 'error', 'always', { 'null': 'ignore' }], //除了与 null 字面量进行比较时，总是强制使用绝对相等
      'comma-dangle': [ 'error', 'never' ], // 要求或禁止使用拖尾逗号
      'template-curly-spacing': [ 'error', 'always' ], // 强制模板字符串中空格
      'rest-spread-spacing': [ 'error', 'never' ], // 强制剩余和扩展运算符及其表达式之间有空格
      'arrow-spacing': 'error', // 要求箭头函数的箭头之前或之后有空格
      'template-tag-spacing': [ 'error', 'always' ], // 禁止在模板标记和它们的字面量之间有空格
      'switch-colon-spacing': 'error', // 强制在 switch 的冒号左右有空格
      'space-infix-ops': 'error', // 要求中缀操作符周围有空格
      'object-curly-spacing': [ 'error', 'always', { 'arraysInObjects': false, 'objectsInObjects': false }], // 强制在花括号中使用一致的空格
      'comma-spacing': [ 'error', { 'before': false, 'after': true }], // 强制在逗号后面使用一致的空格
      'no-multi-spaces': [ 'error', { 'exceptions': { 'Property': false }, 'ignoreEOLComments': false }], // 禁止使用多个空格
      'no-irregular-whitespace': [ 'error', { 'skipTemplates': true }], // 禁止不规则的空白
      'no-extra-semi': 'error', // 禁用不必要的分号
      'react/prop-types': 'off', // 关闭prop-types检查
      'no-unused-vars': 'off', // 允许未使用的变量
      'react/react-in-jsx-scope': 'off', // 关闭React导入检查
      'react-hooks/rules-of-hooks': 'error', // React Hooks 规则
      'react-hooks/exhaustive-deps': 'warn', // React Hooks 依赖检查
      '@typescript-eslint/no-explicit-any': 'warn', // TypeScript any 类型警告
      '@typescript-eslint/no-unused-vars': 'off', // 关闭TypeScript未使用变量检查
      '@typescript-eslint/consistent-type-definitions': [ 'error', 'interface' ] // 一致的类型定义
    },
    settings: {
      react: {
        version: 'detect'
      }
    }
  }
]
