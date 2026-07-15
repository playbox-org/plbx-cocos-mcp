# Исследование: генерация `.meta` файлов без открытия редактора

Цель — убрать ситуации «Import preflight», когда после создания ассета через MCP
(prefab, скрипт агентом, animgraph) пользователя приходится просить открыть
Cocos Creator, чтобы редактор сгенерировал `.meta` и импортировал ассет в `library/`.

Исследование: июль 2026, Cocos Creator 3.8.7/3.8.8 (установлены локально),
реальный проект `project-example/zombie-miner`, официальная документация, исходники
редактора (app.asar), npm-пакет `@cocos/asset-db`, форумы (en+zh).

**Главный вывод: оффлайн-генерация `.meta` реализуема для практически всех нужных
типов и легитимна по официальной модели редактора.** Все «секреты» формата раскрыты,
включая алгоритм subId (`nameToId`), который считался закрытым.

---

## 1. Официальная модель: редактор ДОВЕРЯЕТ принесённому meta

Из [документации 3.8](https://docs.cocos.com/creator/3.8/manual/en/asset/meta.html)
(подтверждено официально):

- Ассет идентифицируется **только по UUID** из meta, не по пути.
- Файл **без** meta → редактор при открытии/refresh сам создаёт meta с новым
  случайным UUID.
- Файл **вместе с** meta → редактор использует принесённый meta как есть,
  **UUID сохраняется**. Это и есть наша легитимная точка входа.
- `library/` — производный кеш. meta без library-записи → редактор до-импортирует
  при следующем открытии, UUID не меняется. Удаление всей `library/` безопасно —
  она полностью регенерируется из assets+meta.

Репозиторий уже пользуется этим два раза: `build_prefab` и `build_animgraph` пишут
meta сами (`PrefabBuilder.createMeta`, `AnimGraphBuilder.createMeta`), и это
работает в бою — редактор подхватывает. Исследование подтверждает, что подход
масштабируется на остальные типы.

## 2. Формат meta — полностью известен

### 2.1 Каркас (единый для всех типов)

Интерфейс из plaintext-типов редактора
(`app.asar: builtin/asset-db/@types/public.d.ts`, дублируется в npm
`@cocos/creator-types@3.8.7`):

```jsonc
{
  "ver": "1.1.50",        // версия ИМПОРТЕРА (Importer.version), не проекта
  "importer": "prefab",   // имя импортера (по расширению, §2.3)
  "imported": true,       // в сохранённых meta всегда true
  "uuid": "…v4…",         // случайный RFC-4122 v4
  "files": [".json"],     // расширения артефактов в library/<xx>/<uuid>*
  "subMetas": {},         // id → вложенный мини-meta (у sub-ассетов)
  "userData": {}          // per-importer настройки
}
```

Порядок ключей стабилен; сериализация — `JSON.stringify(meta, null, 2)`.

### 2.2 UUID — чистый random v4

- Статистика по всем 323 UUID zombie-miner: version-nibble всегда `4`,
  variant равномерно `8/9/a/b` — не-random битов нет.
- Типы редактора (`CreateAssetOptions.uuid?`) прямо описывают: uuid при
  конфликте «автоматически переназначается» — т.е. это рандом с проверкой
  коллизии, без соли/детерминизма.
- **Вывод: `crypto.randomUUID()` (уже используется в PrefabBuilder) — корректно.**

### 2.3 Реестр importer'ов: расширение → importer

Найден **открытым текстом** в app.asar:
`modules/engine-extensions/extensions/engine-extends/package.json` →
`contributions["asset-db"]["asset-handler"]`. 55 хендлеров, набор **идентичен в
3.8.7 и 3.8.8**. Ключевые:

| Расширение | importer | ver (3.8.7) |
|---|---|---|
| (папка) | `directory` | 1.2.0 |
| `.ts` | `typescript` | 4.0.24 |
| `.js .cjs .mjs` | `javascript` | 4.0.24 |
| `.scene .fire` | `scene` | 1.1.50 |
| `.prefab` | `prefab` | 1.1.50 |
| `.mtl` | `material` | 1.0.21 |
| `.pmtl` | `physics-material` | 1.0.1 |
| `.anim` | `animation-clip` | 2.0.4 |
| `.animgraph` | `animation-graph` | 1.2.0 |
| `.animask` | `animation-mask` | — |
| `.jpg .png .jpeg .webp .tga .hdr .bmp .psd .tif .tiff .exr` | `image` | 1.0.27 |
| `.gltf .glb` | `gltf` | 2.3.14 |
| `.fbx` | `fbx` | 2.3.14 |
| `.mp3 .wav .ogg .aac .pcm .m4a` | `audio-clip` | 1.0.0 |
| `.ttf` | `ttf-font` | 1.0.1 |
| `.fnt` | `bitmap-font` | 1.0.6 |
| `.json` | `json` | 2.0.1 |
| `.effect` | `effect` | 1.7.1 |
| `.chunk` | `effect-header` | — |
| `.rt` | `render-texture` | 1.2.1 |
| `.pac` | `auto-atlas` | 1.0.8 |
| `.labelatlas` | `label-atlas` | 1.0.1 |
| `.txt .html .xml .css .yaml .md …` | `text` | — |
| `.mp4` | `video-clip` | 1.0.0 |
| `.plist` | `particle` / `sprite-atlas` | — |
| `.tmx` | `tiled-map` | — |
| `.json .skel` (spine) | `spine-data` | — |
| fallback | `unknown` | — |

Sub-importer'ы (порождаются родителем, расширений не имеют): `texture` (1.0.22),
`sprite-frame` (1.0.12), `gltf-mesh` (1.1.1), `gltf-material` (1.0.14),
`gltf-scene` (1.0.14), `gltf-skeleton` (1.0.1), `gltf-animation` (1.0.18),
`gltf-embeded-image`, `rt-sprite-frame`.

`ver` = `Importer.version` — между минорами движка может меняться; снимать с
реальных meta целевой версии (как уже сделано для prefab/animgraph).

### 2.4 subId разгадан: `nameToId` = выборка из md5

Ключи `subMetas` (те самые `6c48a`/`f9941`) генерирует функция `nameToId` из
`@editor/asset-db/libs/utils` — в редакторе она зашифрована (`.ccc`), но
**пакет `@cocos/asset-db` опубликован в npm открыто** (используется официальным
headless `cocos/cocos-cli`), и реализация оттуда:

```js
// @cocos/asset-db/libs/utils.js (npm, 3.0.0-alpha.10)
const _extendIndex = [1,2,3,4,5,7,8,9,10,11,12,13,14,15,17,18,19,20,21,22,23,24,26,27,28,29,30];
function nameToId(name, extend = 0) {
  const h = createHash('md5').update(name).digest('hex');
  let id = h[0] + h[6] + h[16] + h[25] + h[31];   // 5 символов md5-hex
  for (let i = 0; i < extend; i++) id += h[_extendIndex[i]];
  return id;
}
```

**Верифицировано на реальных данных** (июль 2026, zombie-miner):

| вход (`subMeta.name`) | nameToId | реальный subId |
|---|---|---|
| `texture` | `6c48a` | `6c48a` ✔ |
| `spriteFrame` | `f9941` | `f9941` ✔ |
| `Circle.019.mesh` (Coin.fbx, gltf-mesh) | `2e1ee` | `2e1ee` ✔ |
| `Coin1.material` (gltf-material) | `a424f` | `a424f` ✔ |
| `Coin.prefab` (gltf-scene) | `4b8b9` | `4b8b9` ✔ |

Хешируется ровно поле `name` sub-ассета. Sub-uuid = `<root-uuid>@<subId>`;
в сценах сжимается только uuid-часть (`src/utils/uuid.js: splitSubAssetRef` — уже
реализовано).

### 2.5 userData по типам (эмпирика zombie-miner + internal db)

| Тип | userData | subMetas |
|---|---|---|
| directory | `{}` (bundle-capable: `compressionType`, `isRemoteBundle`) | — |
| ts / js | `{}` | — |
| scene | `{}` | — |
| prefab | `{"syncNodeName": "<имя корня>"}` | — |
| mtl / animgraph / effect / json / pmtl | `{}` | — |
| anim | `{"name": "<clip name>"}` | — |
| audio | `{"downloadMode": 0}` | — |
| ttf | `{}` | — |
| image | `type` (`texture` \| `sprite-frame` \| `raw` …), `hasAlpha`, `fixAlphaTransparencyArtifacts`, `redirect: "<uuid>@6c48a"` | `6c48a` texture (всегда), `f9941` spriteFrame (при type=sprite-frame) |
| fbx/glb | `imageMetas`, `fbx:{}`, `lods`, `assetFinder` (ссылки на свои sub-uuid), `materials` (ПОЛНЫЕ сериализованные cc.Material), `animationImportSettings` | gltf-mesh/-material/-scene/-skeleton/-animation |

Sub-meta `f9941` (spriteFrame) несёт производные данные картинки: trim
(`offsetX/Y, trimX/Y, width/height, rawWidth/rawHeight`), 9-slice borders,
`vertices {rawPosition, uv, nuv, minPos, maxPos}`, `imageUuidOrDatabaseUri:
"<root-uuid>@6c48a"`. Всё вычислимо из размеров изображения (PNG-заголовок
читается тривиально), но см. открытый вопрос §6.1 — возможно, достаточно
каркаса, редактор дозаполнит при импорте.

### 2.6 Что НЕ хранится в meta

- **Compressed uuid скриптов (cid)** — НЕ хранится. Реальный `.ts.meta` — это
  голый каркас с `userData: {}`. Компрессия uuid → короткий id компонента
  считается в рантайме (алгоритм уже в `src/utils/uuid.js`). Для регистрации
  скрипта достаточно валидного uuid.

## 3. meta ↔ library: что обязано существовать

Схема library: `library/<первые 2 hex uuid>/<uuid>[@subId].<ext>`; `meta.files`
перечисляет расширения. Проверено на zombie-miner:

- **prefab**: library-копия **байт-в-байт равна** исходнику (`cmp` identical).
- **mtl**: почти копия (редактор проставляет `_name`).
- **anim**: JSON → бинарный CCON (`CCON\x02`).
- **image**: `<uuid>.json` (cc.ImageAsset) + копия картинки + `@6c48a.json`
  (cc.Texture2D) + `@f9941.json` (cc.SpriteFrame).
- **скрипты (`files: []`)**: library-записей нет вообще.
- Служебные индексы: `library/.assets-info.json` (`path → {time, uuid}`) и др. —
  редактор по ним понимает, что нужно до-импортировать.

**library писать не нужно и не стоит** — это регенерируемый кеш, редактор
до-импортирует по meta, сохранив наш uuid. Исключение-ограничение: **сам MCP
читает library** (mesh AABB в `AssetInspector`, gltf-scene prefab для
`instantiate_prefab` моделей) — поэтому для свежедобавленных **моделей**
генерация meta проблему не закрывает: без импорта редактором не будет
`library/<xx>/<uuid>@<subId>.json`, которые нужны нам самим.

## 4. Headless-альтернативы (заставить движок без GUI)

1. **`CocosCreator --project <path> --build "platform=web-desktop;…"`** —
   единственный документированный CLI-режим
   ([docs](https://docs.cocos.com/creator/3.8/manual/en/editor/publish/publish-in-command-line.html)).
   Подтверждено кодом (`launch/source/launch.ts` в app.asar): перед сборкой
   поднимается asset-db worker и **импортируются все ассеты** (meta + library
   генерируются). Коды возврата: 32 — плохие параметры, 34 — ошибка сборки,
   36 — успех. Минусы: тяжёлый (полная сборка, минуты), требует
   GUI-окружения (это Electron без окна; на macOS локально ок, Linux-CI —
   только с xvfb, неофициально), путь к установленному Creator нужно знать.
   Отдельной команды «только импорт/refresh» **нет** (argv: `--project`,
   `--home`, `--build`, `--test`, `--nologin`, `--metric`, `--dev`).
2. **Editor extension + `Editor.Message.request('asset-db', 'refresh-asset' | 'create-asset' | …)`** —
   официальный API, но живёт только внутри запущенного GUI-редактора. Так
   работают все существующие Cocos MCP-серверы (DaxianLee/cocos-mcp-server,
   RomaRogov/cocos-mcp — оба плагины в редакторе). Для нашей оффлайн-модели
   не подходит как основной путь; полезно как опциональный «мост», если
   редактор уже открыт.
3. **`cocos/cocos-cli`** — официальный headless CLI с открытым asset-db
   (`create/build/import/info/start-mcp-server`), но привязан к **Cocos 4.0**
   (engine `4.0.0-alpha.26`) — для 3.8 неприменим. Ценен как открытый референс
   форматов/алгоритмов (именно оттуда вытащен `nameToId`); Cocos сам движется
   к headless asset-db + MCP.
4. **Код asset-db редактора 3.8** зашифрован (`.ccc`-модули, расшифровка в
   нативном биндинге кастомного Electron) — статически не читается; переносить
   его код к себе невозможно, но и не нужно (см. §2).

## 5. Рекомендация: что реализовать в MCP

### Ярус 1 — тривиально (каркас + 0-1 поле userData), закрывает главную боль

`.ts` / `.js` (**главный кейс** — скрипты, созданные агентом), `.scene`, `.mtl`,
`.anim`, `.pmtl`, `.json`, `.effect`, `directory` (meta нужен и папкам!).
`prefab`/`animgraph` уже реализованы — вынести `createMeta` в общий модуль
(например `src/document/MetaGenerator.js`) с таблицей `ext → {importer, ver,
defaultUserData}`.

Эффект для `.ts`: `ScriptResolver` сканирует `*.ts.meta` → сразу после генерации
meta `add_component` нового скрипта работает без редактора; редактор при
следующем открытии просто до-импортирует, uuid сохранится, ссылки в сценах
останутся валидными.

Форма тула: `create_asset_meta {assetPath | folder, recursive?}` — генерирует
meta для файла/папки, **пропуская всё, у чего meta уже есть** (идемпотентность,
чтобы не породить uuid-конфликт). Плюс автоматический вызов из будущих тулов,
создающих файлы. Директории по пути тоже получают meta (редактор требует meta
на каждую папку в `assets/`).

### Ярус 2 — реализуемо с расчётом производных данных

- **image** (`.png/.jpg/...`): каркас + `subMetas` с константными id
  (`6c48a`/`f9941` — теперь вычислимыми через `nameToId`), размеры из заголовка
  картинки, trim/vertices по образцу `Handle_Plain.png.meta`. Вопрос
  минимально-достаточного userData — верифицировать re-save'ом (§6.1).
- **audio / ttf / rt**: каркас + 0-2 поля.

### Ярус 3 — НЕ генерировать вручную: fbx/glb

`userData.materials` (полные cc.Material), `assetFinder`, `imageMetas` зависят
от содержимого модели, и — главное — **MCP сам нуждается в library-артефактах
модели** (mesh, gltf-scene prefab), которые создаёт только импорт движком.
Для моделей корректный ответ:
- оставить текущий «попросить открыть редактор», либо
- опциональный тул/режим `trigger_editor_import` — запуск
  `CocosCreator --project X --build …` headless (путь к Creator — из конфига
  или auto-discovery `/Applications/Cocos/Creator/<ver>`), как тяжёлый, но
  автоматический fallback. Стоит проверить самый дешёвый вариант сборки
  (минимальная платформа/`stage`), прежде чем предлагать пользователям.

### Что зафиксировать в коде

- Таблица `ext → {importer, ver, userDataFactory}` — данные версии 3.8.7,
  рядом комментарий-источник (engine-extends contributions + реальные meta).
- `nameToId` — добавить в `src/utils/uuid.js` (5 строк, verified).
- В `get_asset_info` маркер «exists on disk but has no .meta» дополнить
  подсказкой на новый тул.
- SKILL: секцию «Import preflight» переписать — для скриптов/простых ассетов
  редактор больше не нужен; открытие редактора остаётся только для моделей.

## 6. Открытые вопросы — РЕШЕНЫ (2026-07-15, реализация в src/document/MetaGenerator.js)

1. **Минимальный image-meta** → не гадать: генерируем **полную форму** по
   образцу реальных мет (userData `type/hasAlpha/fixAlphaTransparencyArtifacts/
   redirect`; subMeta `6c48a` всегда, `f9941` при `type: "sprite-frame"`).
   Размеры — из заголовка PNG/JPEG (hasAlpha — из colorType/tRNS), trim —
   плейсхолдер «всё изображение» с `trimType: "auto"`: производными полями
   владеет импортер и пересчитает их при следующем импорте, uuid не тронет.
   `compressSettings` не пишем (проектная настройка, редактор добавит).
   Sprite-frame для форматов без парсинга заголовка (webp/tga/…) — отказ с
   подсказкой; `type: "texture"` работает для всех расширений (размеры там
   не нужны). Разовая верификация re-save'ом остаётся желательной, но форма
   снята с editor-saved мет — риск минимальный.
2. **`ver` ниже текущего** → пинним значения 3.8.7 в таблице `SIMPLE_TYPES`
   с комментарием-источником; у Importer есть `migrations`, редактор штатно
   мигрирует старые `ver` вверх. Ничего дополнительно не делаем.
3. **Editor re-save шум fbx** → подтверждает решение: модели не генерируем
   вовсе, `create_asset_meta` отвечает объясняющим отказом (плюс MCP сам
   нуждается в library-артефактах моделей).
4. **Headless `--build`** → НЕ реализуем сейчас (тяжёлый, требует GUI-окружения
   и пути к Creator). Остаётся единственным открытым пунктом — возможный
   будущий opt-in `trigger_editor_import` для моделей.

Итог реализации: `nameToId` в `src/utils/uuid.js`; `src/document/MetaGenerator.js`
(таблица ext → importer/ver, image-мета, идемпотентная запись, меты папок);
тул `create_asset_meta` (19-й); `build_prefab`/`build_animgraph` переведены на
общий модуль и метят создаваемые папки; `get_asset_info` подсказывает новый тул.

## 7. Источники

- Официально: [meta files 3.8](https://docs.cocos.com/creator/3.8/manual/en/asset/meta.html) ·
  [asset workflow](https://docs.cocos.com/creator/3.8/manual/en/asset/asset-workflow.html) ·
  [publish-in-command-line](https://docs.cocos.com/creator/3.8/manual/en/editor/publish/publish-in-command-line.html) ·
  [build-guide](https://docs.cocos.com/creator/3.8/manual/en/editor/publish/build-guide.html) ·
  [contributions-database](https://docs.cocos.com/creator/3.8/manual/en/editor/extension/contributions-database.html)
- Код: app.asar 3.8.7/3.8.8 (`builtin/asset-db/@types/*.d.ts`,
  `engine-extends/package.json`, `launch/source/launch.ts`,
  `@editor/creator/dist/require.js` — загрузчик `.ccc`) ·
  npm [`@cocos/asset-db`](https://www.npmjs.com/package/@cocos/asset-db) (nameToId) ·
  npm `@cocos/creator-types@3.8.7` ·
  [cocos/cocos-cli](https://github.com/cocos/cocos-cli) ·
  [cocos/cocos-creator-extensions](https://github.com/cocos/cocos-creator-extensions)
- Эмпирика: `project-example/zombie-miner` (323 meta, library-корреляция),
  internal db редактора (`editor/assets/**`)
- Экосистема: [DaxianLee/cocos-mcp-server](https://github.com/DaxianLee/cocos-mcp-server) ·
  [RomaRogov/cocos-mcp](https://github.com/RomaRogov/cocos-mcp) — оба требуют
  живой редактор; оффлайн-генерацию meta не делает никто (наша ниша).
- Форум: [uuid-конфликты zh](https://forum.cocos.org/t/topic/148583) ·
  [fbx meta шум](https://forum.cocos.org/t/topic/136051/8) ·
  [CLI build 3.8.6](https://forum.cocosengine.org/t/command-line-build-with-cocoscreator-3-8-6/62463)
