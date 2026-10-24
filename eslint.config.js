// Strict, zero-warning lint for faceslop (`npm run lint` = eslint . --max-warnings 0).
//
// App code gets no exemptions. Generated shadcn components (src/components/ui/**) get only the
// targeted exemptions listed in their own block below, each with the reason.
import js from '@eslint/js';
import eslintReact from '@eslint-react/eslint-plugin';
import { plugin as shadcn } from '@shadcn/lint';
import pluginQuery from '@tanstack/eslint-plugin-query';
import pluginRouter from '@tanstack/eslint-plugin-router';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactYouMightNotNeedAnEffect from 'eslint-plugin-react-you-might-not-need-an-effect';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TS = ['**/*.{ts,tsx,mts,cts}'];
const TSX = ['**/*.tsx'];
const UI = ['src/components/ui/**/*.{ts,tsx}'];

/** Rules @eslint-react duplicates from eslint-plugin-react-hooks; the react-hooks versions (React Compiler-powered) win. */
const eslintReactHooksDuplicates = Object.fromEntries(
  [
    'error-boundaries',
    'exhaustive-deps',
    'purity',
    'rules-of-hooks',
    'set-state-in-effect',
    'set-state-in-render',
    'static-components',
    'unsupported-syntax',
    'use-memo',
  ].map((rule) => [`@eslint-react/${rule}`, 'off']),
);

/**
 * Every rule that is on is an error. Several presets (@eslint-react, @tanstack/*) turn rules on as
 * warnings; `--max-warnings 0` would fail on them anyway, but editors and other runners would not.
 */
const allErrors = (configs) =>
  configs.map((config) => {
    if (!config.rules) return config;
    const promote = (entry) => {
      const [severity, ...options] = Array.isArray(entry) ? entry : [entry];
      if (severity !== 'warn' && severity !== 1) return entry;
      return options.length > 0 ? ['error', ...options] : 'error';
    };
    return { ...config, rules: Object.fromEntries(Object.entries(config.rules).map(([rule, entry]) => [rule, promote(entry)])) };
  });

export default allErrors(defineConfig([
  globalIgnores([
    '.output/**',
    'dist/**',
    '.data/**',
    '.nitro/**',
    '.tanstack/**',
    '.scratch/**',
    'node_modules/**',
    'src/routeTree.gen.ts',
  ]),

  // ---------- everything ----------
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error', 'info', 'log'] }],
      'no-param-reassign': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
    },
  },

  // ---------- TypeScript (type-aware) ----------
  {
    files: TS,
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Effect.gen generators legitimately have no `yield` (e.g. `return yield* new AppError(...)` is fine,
      // but plain early returns in a generator are normal Effect style).
      'require-yield': 'off',
    },
  },

  // ---------- React ----------
  {
    // Every client-side file, .ts included: custom hooks (src/hooks/*.ts, e.g. the remote-view
    // EventSource hook) need rules-of-hooks and the effect rules as much as components do.
    // src/server/** is not React (and Effect's `Service.use(...)` is not a hook).
    files: [...TSX, 'src/**/*.ts'],
    ignores: ['src/server/**'],
    extends: [
      eslintReact.configs['strict-type-checked'],
      reactHooks.configs.flat['recommended-latest'],
      reactYouMightNotNeedAnEffect.configs.strict,
    ],
    rules: {
      ...eslintReactHooksDuplicates,
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/incompatible-library': 'error',
      'react-hooks/unsupported-syntax': 'error',
    },
  },
  {
    files: TSX,
    extends: [jsxA11y.flatConfigs.strict],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [pluginRouter.configs['flat/recommended'], pluginQuery.configs['flat/recommended-strict']],
  },

  // ---------- design system (@shadcn/lint; reads components.json + src/styles.css) ----------
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { shadcn },
    settings: {
      shadcn: {
        note: 'Theme tokens live in src/styles.css (light + .dark). Components live in src/components/ui.',
      },
    },
    rules: {
      // Components own their look. Pages may only place them: margins, width/height/size,
      // flex/grid placement, position (category "layout"). Padding, gap, color, type, shape are theirs.
      'shadcn/no-restyle': ['error', { allow: ['layout'] }],
      'shadcn/no-raw-colors': 'error',
      'shadcn/no-arbitrary-values': 'error',
      'shadcn/no-inline-styles': 'error',
      'shadcn/no-unknown-classes': 'error',
      'shadcn/require-static-classes': 'error',
    },
  },

  // ---------- environments ----------
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Server-only code, tests, scripts, and config files run on Node.
    files: ['src/server/**/*.ts', 'test/**/*.{ts,tsx}', 'scripts/**/*.ts', '*.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ---------- architecture boundaries ----------
  {
    // Client-reachable code may call server functions but never import server internals.
    // (src/routes/api/** are server routes and src/start.ts only uses server modules inside
    // `.server()` middleware: Start strips both from the client build. src/server.ts is the
    // server entry.)
    files: ['src/routes/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}', 'src/shared/**/*.ts', 'src/*.{ts,tsx}'],
    ignores: ['src/routes/api/**', 'src/server.ts', 'src/start.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'playwright', message: 'Server only: use a service in src/server through a server function.' },
            { name: '@effect/sql-sqlite-node', message: 'Server only: use a repository through a server function.' },
          ],
          patterns: [
            {
              regex: '^@/server/(?!functions/)',
              message: 'Client code may import server functions (@/server/functions/*) only.',
            },
            { regex: '^node:', message: 'Node built-ins are server only.' },
            { regex: '^effect/sql', message: 'Server only.' },
          ],
        },
      ],
    },
  },
  {
    // Server functions go through services; they never touch the database or Chrome directly.
    files: ['src/server/functions/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'playwright', message: 'Use the Browser/Marketplace/... services.' },
            { name: '@effect/sql-sqlite-node', message: 'Use a repository service.' },
          ],
          patterns: [{ regex: '^effect/sql', message: 'Use a repository service.' }],
        },
      ],
    },
  },

  // ---------- generated shadcn components: targeted, documented exemptions ----------
  // src/components/ui/* is copied verbatim from the shadcn React Aria registry (`npx shadcn add`).
  // Re-adding a component overwrites local edits, so instead of patching upstream code we exempt
  // exactly the rules each file trips. App code gets none of these.
  {
    files: UI,
    rules: {
      // They ARE the design system: they compose other components with classes and use the
      // registry's arbitrary values (e.g. rounded-[min(var(--radius-md),8px)]).
      'shadcn/no-restyle': 'off',
      'shadcn/no-arbitrary-values': 'off',
      // Upstream style: `||` on optional strings, `useContext`, `<Context.Provider>`, `T[]` vs
      // generic arrays, `type` vs `interface`, inline type specifiers.
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@eslint-react/no-use-context': 'off',
      '@eslint-react/no-context-provider': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/no-import-type-side-effects': 'off',
      // Upstream compares with `!= null` / `== null` (combobox, field, progress).
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // alert-dialog.tsx imports a type it never uses.
    files: ['src/components/ui/alert-dialog.tsx'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
  {
    // avatar.tsx: `onLoadingStatusChange={(s) => setStatus(s)}`-style void-returning shorthand arrows.
    files: ['src/components/ui/avatar.tsx'],
    rules: { '@typescript-eslint/no-confusing-void-expression': 'off' },
  },
  {
    // checkbox/radio-group/switch use RAC primitives deprecated in react-aria-components 1.22
    // (CheckboxField/RadioField/SwitchField); the registry hasn't moved yet.
    files: ['src/components/ui/{checkbox,radio-group,switch}.tsx'],
    rules: { '@typescript-eslint/no-deprecated': 'off' },
  },
  {
    // combobox.tsx forwards RAC's `any`-typed selection key.
    files: ['src/components/ui/combobox.tsx'],
    rules: { '@typescript-eslint/no-unsafe-argument': 'off' },
  },
  {
    // dropdown-menu.tsx spells out RAC's default generic (`MenuItemProps<object>`).
    files: ['src/components/ui/dropdown-menu.tsx'],
    rules: { '@typescript-eslint/no-unnecessary-type-arguments': 'off' },
  },
  {
    // field.tsx renders `children` conditionally, optional-chains a non-nullable, keys errors by
    // index, and compares a length with `==`.
    files: ['src/components/ui/field.tsx'],
    rules: {
      eqeqeq: 'off',
      '@eslint-react/no-leaked-conditional-rendering': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@eslint-react/no-array-index-key': 'off',
    },
  },
  {
    // input-group.tsx: clicking the addon focuses the input (pointer convenience; keyboard users
    // reach the input directly), and its button sizes are picked from a lookup.
    files: ['src/components/ui/input-group.tsx'],
    rules: {
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/no-noninteractive-element-interactions': 'off',
      'shadcn/require-static-classes': 'off',
    },
  },
  {
    // select.tsx: autoFocus moves focus into the open listbox (React Aria's focus management).
    files: ['src/components/ui/select.tsx'],
    rules: { 'jsx-a11y/no-autofocus': 'off' },
  },
  {
    // progress.tsx sets the bar width, and tooltip.tsx positions its arrow, through `style`
    // (values computed at runtime by React Aria).
    files: ['src/components/ui/{progress,tooltip}.tsx'],
    rules: { 'shadcn/no-inline-styles': 'off' },
  },
  {
    // slider.tsx: one thumb per value; thumbs are positional, so the index is the identity.
    files: ['src/components/ui/slider.tsx'],
    rules: { '@eslint-react/no-array-index-key': 'off' },
  },
  {
    // sonner.tsx: sonner's `toaster` hook class is not a Tailwind class. (Its `style` only sets
    // CSS variables, which shadcn/no-inline-styles allows.)
    files: ['src/components/ui/sonner.tsx'],
    rules: { 'shadcn/no-unknown-classes': 'off' },
  },
  {
    // toggle-group.tsx builds its context value inline.
    files: ['src/components/ui/toggle-group.tsx'],
    rules: { '@eslint-react/no-unstable-context-value': 'off' },
  },
  {
    // tooltip.tsx splits trigger/content children with Children.toArray.
    files: ['src/components/ui/tooltip.tsx'],
    rules: { '@eslint-react/no-children-to-array': 'off' },
  },

  // ---------- plain JS config files: no type information ----------
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
]));
