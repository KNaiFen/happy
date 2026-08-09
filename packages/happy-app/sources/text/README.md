# Happy App i18n

The Happy App uses a typed, object-based translation system. Translation values
are strings or functions, and callers use `t('dot.notation.key', params)`.
It does not use an i18n framework, but it does use `expo-localization` to read
the device locale.

## Runtime behavior

At module initialization, the resolver selects a language in this order:

1. `settings.settings.preferredLanguage`, when it is one of the supported
   language codes;
2. the first matching device locale reported by `expo-localization`;
3. `DEFAULT_LANGUAGE` (`en`).

Chinese device locales select `zh-Hans` or `zh-Hant` from the script code; an
unknown Chinese variant falls back to `zh-Hans`.

The module exports:

- `t`: the typed translation function;
- `getCurrentLanguage`: the selected `SupportedLanguage`;
- `TranslationKey` and `TranslationParams<K>` types;
- `SUPPORTED_LANGUAGES`, `SUPPORTED_LANGUAGE_CODES`, `DEFAULT_LANGUAGE`, and
  the language-name helpers.

There are no `hasTranslation`, `getAllTranslationKeys`, or
`getTranslationValue` runtime APIs.

## Usage

```ts
import { t } from '@/text';

t('common.cancel');
t('tabs.settings');
t('status.connected');
t('time.minutesAgo', { count: 1 });
t('errors.fieldError', { field: 'Email', reason: 'Invalid format' });
```

`t` validates the dot-notation key and function parameter shape at compile
time. Static strings take no parameter object; function-valued translations
require the shape declared in the English source object.

## Files

- `_default.ts`: English source object and the canonical `Translations` /
  `TranslationStructure` types.
- `_all.ts`: supported language codes, metadata, default language, and name
  helpers.
- `translations/*.ts`: one object per non-English language.
- `index.ts`: imports the language objects, resolves the locale, and exports
  the public API.

Every language object is assigned to `Record<SupportedLanguage,
TranslationStructure>`, so TypeScript rejects a translation that does not match
the English structure.

## Adding Copy

1. Add the key to `_default.ts`.
2. Add the same key with a compatible value and parameter shape to every file
   under `translations/`.
3. Use `t` with the new key. Run the App typecheck to prove all locale objects
   still match the canonical structure.

Use functions for values that need parameters or plural logic. Keep parameters
named and typed at the translation declaration; callers then receive the same
type checking as the English source.

## Adding a Language

1. Add the code to `SupportedLanguage` and its metadata to
   `SUPPORTED_LANGUAGES` in `_all.ts`.
2. Create `translations/<code>.ts` with the full `TranslationStructure`.
3. Import the object in `index.ts` and add it to `translations`.
4. Run the App typecheck before relying on the new locale.

The language object must be imported and mapped in `index.ts`; adding only a
file or only a code is intentionally rejected by the type-level record check.
