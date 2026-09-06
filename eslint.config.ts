import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import typeormTypescriptRecommended from 'eslint-plugin-typeorm-typescript/recommended';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  typeormTypescriptRecommended,
  {
    /**
     * `**\/*.js` покрывает и результат компиляции страницы-конструктора
     * (`examples/server/public/js`): линтовать сгенерированный код незачем,
     * а его исходники на TypeScript проверяются наравне с остальным кодом.
     */
    ignores: ['node_modules', 'build', '**/*.js'],
  },
  {
    languageOptions: {
      parserOptions: {
        warnOnUnsupportedTypeScriptVersion: false,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      /**
       * Sometimes you have to be a bit tricky in tests, so I'll disable the rule
       */
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  }
);
