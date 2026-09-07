/**
 * @file Конфигурация ESLint (flat config).
 *
 * ПРО `jiti` В devDependencies. Конфиг написан на TypeScript, а ESLint сам его прочитать
 * не умеет — для `.ts` он загружает файл через `jiti`, объявленный у него необязательной
 * peer-зависимостью. Пакет нигде не импортируется, поэтому выглядит лишним; без него
 * `yarn lint` падает с «The 'jiti' library is required for loading TypeScript
 * configuration files» ещё до первой проверенной строки.
 */
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
