# PLBX Cocos MCP Server

MCP (Model Context Protocol) сервер для работы со сценами и префабами Cocos Creator 3.x в AI coding assistants: чтение компактных семантических графов и **корректное редактирование/создание** сцен и префабов семантическими операциями.

> **PLBX** = Playbox - internal tooling for game development workflows

## Что делает

- **Чтение**: конвертирует тяжёлые файлы сцен (~700KB, 40k строк JSON) в компактные семантические графы (~20KB). Компрессия ~36:1.
- **Запись**: lossless-слой поверх формата редактора — батчи семантических операций с валидацией инвариантов и атомарной записью. Канон сериализации верифицирован **байт-в-байт** с выводом Cocos Creator 3.8.7 на golden-корпусе реального проекта.
- **Создание**: `build_prefab` разворачивает компактный спек (~30 строк) в полный корректный `.prefab` + `.meta` (~400–800 токенов вместо 15–50k при ручной генерации JSON).
- **Измерения**: AABB поддеревьев, точная арифметика fit-scale, линт ассетов.

LLM никогда не редактирует `.scene`/`.prefab` напрямую: файл не влезает в контекст, а `__id__` — индексы массива, вставка в середину ломает все последующие ссылки. Только семантические MCP-операции.

## Совместимость

| Инструмент | Поддержка | Конфигурация |
|------------|-----------|--------------|
| **Claude Code** | ✅ | `.mcp.json` |
| **Cursor** | ✅ | `.cursor/mcp.json` |
| **KiloCode** | ✅ | MCP Marketplace |
| **Cline** | ✅ | Extension settings |
| **Windsurf** | ✅ | MCP settings |
| **JetBrains AI** | ✅ | AI Assistant settings |
| **Zed** | ✅ | MCP settings |

## MCP Tools (14)

### Чтение

| Tool | Описание |
|------|----------|
| `query_scene_graph` | Минифицированная иерархия сцены |
| `query_prefab_graph` | Минифицированная иерархия префаба |
| `list_scene_scripts` | Список TypeScript скриптов сцены |
| `find_scene_nodes` | Поиск нодов по паттерну (regex) |
| `inspect_node` | Полное поддерево конкретного нода без фильтрации; asset-ссылки резолвятся в имена (встроенные fbx-материалы помечены `(embedded)`); на свёрнутом префаб-инстансе разворачивает внутренности исходного префаба (read-only, с target-путями для `set_instance_property`) и список overrides |

### Интроспекция проекта и ассетов

| Tool | Описание |
|------|----------|
| `get_project_info` | Версия движка, designResolution, слои, физика |
| `get_asset_info` | Детали ассета: спрайт (rect/trim/9-slice), меш (AABB), префаб, материал; вход — путь или UUID (полный/сжатый/суб-ассет) |
| `list_assets` | Каталог ассетов с фильтрами (тип/папка/маска), путь+UUID |

### Запись

| Tool | Описание |
|------|----------|
| `apply_edits` | Батч семантических правок сцены/префаба (см. ниже) с валидацией, `dryRun` и атомарной записью |
| `validate_document` | Проверка инвариантов файла (ссылки, двунаправленность parent/children и component/node, `_id`/`fileId`, ассеты, euler/quat, wrapper-правило) |
| `build_prefab` | Создание нового `.prefab` (+`.meta` с UUID) из компактного спека |

### Измерения и гигиена

| Tool | Описание |
|------|----------|
| `get_node_bounds` | World/local AABB поддерева (меши, UITransform, свёрнутые префаб-инстансы); local — готовые center/size для BoxCollider |
| `compute_fit_scale` | Точный масштаб под целевой размер (fit-inside по нескольким осям), готовый op в ответе |
| `lint_assets` | Криптоимена (`mesh_001`, `Sprite(2)`), разброс размеров моделей, нарушения wrapper-правила, консистентность материалов (встроенный fbx-материал vs материал проекта на одном меше) |

## Редактирование сцен

`apply_edits` принимает батч операций — всё или ничего: ops → перенумерация → валидация → атомарная запись только валидного результата. В ответе — минифицированные поддеревья затронутых участков. `dryRun: true` показывает результат без записи.

Десять операций:

- `set_node_property` — name/active/layer/mobility/position/rotation/scale (euler автоматически синхронизирует кватернион)
- `add_node`, `remove_node` (+ чистка реестра инстансов и внешних ссылок), `reparent`
- `add_component` — шаблон `cc.*` или кастомный скрипт по имени
- `set_component_property` — формы значений `$node`/`$asset`/`$component`, слияние value-типов
- `set_asset_ref` — ссылка на ассет по пути/UUID/`uuid@subId`
- `instantiate_prefab` — свёрнутый инстанс (стаб + overrides), принимает `.prefab`, модель (gltf-scene из `library/`) или `model@subId`
- `set_instance_property` / `remove_instance_override` — overrides инстансов; `target` — путь внутри исходного префаба

**Адресация нод** — путь (`Canvas/Panel/BuyBtn`, `Name[i]` для одноимённых) или стабильный `_id` ноды. Никогда `__id__` — индексы съезжают после каждой записи.

**Политика префабов**: правь исходный ассет, не инстанс — инстансы наследуют изменения. Внутренности инстансов в файле не существуют (свёрнутая сериализация) и правятся только через overrides; читать их можно — `inspect_node` на инстансе разворачивает исходный префаб с target-путями и текущими overrides.

**Wrapper-конвенция** (`build_prefab`): модель/спрайт никогда не корень префаба. `Root` (scale 1, здесь логика/твины/коллайдеры) → `Visual`-ребёнок (модель с корректирующим скейлом). Валидатор предупреждает о нарушениях.

## Установка

```bash
npm install plbx-cocos-mcp
```

Или для разработки:

```bash
git clone https://github.com/nicenemo/plbx-cocos-mcp
cd plbx-cocos-mcp
npm install
```

## Конфигурация

`COCOS_PROJECT_ROOT` — корень анализируемого Cocos-проекта (не этого репозитория); без него используется cwd.

### Claude Code

`.mcp.json` в корне проекта (или `claude mcp add cocos --env COCOS_PROJECT_ROOT=/path/to/game -- node /path/to/plbx-cocos-mcp/src/index.js`):

```json
{
  "mcpServers": {
    "plbx-cocos": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/plbx-cocos-mcp/src/index.js"],
      "env": {
        "COCOS_PROJECT_ROOT": "/path/to/cocos/project"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "plbx-cocos": {
      "command": "node",
      "args": ["/path/to/plbx-cocos-mcp/src/index.js"],
      "env": {
        "COCOS_PROJECT_ROOT": "/path/to/cocos/project"
      }
    }
  }
}
```

Для prompt-driven работы в Claude Code существует SKILL `cocos-scene-builder` (политика поверх этих тулов: рецепты, онбординг-интервью, цикл верификации); распространяется отдельно от этого репозитория.

## CLI Usage

```bash
# Вывод в консоль
node bin/scene-minifier.js assets/Scenes/game.scene

# Сохранение в файл
node bin/scene-minifier.js assets/Scenes/game.scene -o graph.txt

# JSON формат
node bin/scene-minifier.js assets/Scenes/game.scene --json > scene.json
```

Корень проекта определяется автоматически (подъём вверх до каталога с `assets/`); переопределить — `COCOS_PROJECT_ROOT` или `--project-root <dir>`.

## Архитектура

```
src/
├── core/                    # Чтение (lossy) + интроспекция
│   ├── SceneParser.js       # Парсинг плоского JSON-массива сцены
│   ├── ScriptResolver.js    # Сжатый UUID → имя скрипта
│   ├── NodeTreeBuilder.js   # Минифицированное дерево
│   ├── PropertyExtractor.js # Свойства кастомных компонентов
│   ├── SceneMinifier.js     # Фасад-оркестратор (DI)
│   ├── AssetIndex.js        # Скан assets/**/*.meta, путь↔UUID
│   ├── AssetInspector.js    # Детали ассетов (rect/AABB/материалы)
│   └── ProjectInfoReader.js # Версия движка, настройки проекта
├── document/                # Запись (lossless)
│   ├── SceneDocument.js     # load → mutate → validate → save; канон = DFS-перенумерация
│   ├── operations.js        # Семантические операции
│   ├── instances.js         # Свёрнутые префаб-инстансы и overrides
│   ├── ComponentTemplates.js# Полные шаблоны компонентов 3.8.x
│   ├── Validator.js         # Инварианты (ошибки) + конвенции (warnings)
│   ├── PrefabBuilder.js     # Спек-компилятор build_prefab
│   ├── Bounds.js            # AABB поддеревьев
│   └── MiniTree.js          # Компактные поддеревья для ответов
├── filters/                 # Расширяемые фильтры шума
├── formatters/              # Text / Json / Stats
├── utils/                   # uuid (компрессия), glb, math3d, fileId
├── tools/                   # 14 MCP-тулов (BaseTool + реестр index.js)
└── server/McpServer.js      # MCP protocol handler (stdio)
```

## Формат Cocos Creator 3.x — верифицированные заметки

Проверено кодом на golden-корпусе реального проекта (Cocos Creator 3.8.7, 3D): сцена 1.2MB (3549 объектов) + 4 префаба; round-trip и приёмка в редакторе — байт-в-байт.

- Файл = плоский JSON-массив; `{"__id__": N}` — индекс в массиве; `__type__` кастомных компонентов — сжатый UUID (первые 5 hex как есть + 27 hex пакуются по 3 hex → 2 base64-символа; алгоритм в `src/utils/uuid.js`).
- **Порядок сериализации** — ключ ко всей записи: порядок объектов = depth-first порядок первого посещения при обходе всего графа ссылок от объекта 0. Кросс-ссылки «вытягивают» объекты вперёд. Вывод = `JSON.stringify(arr, null, 2)` без завершающего `\n`.
- Нода: `_parent`/`_children` двунаправленны; у компонентов обратная ссылка `node`; value-типы (`cc.Vec3` и т.п.) инлайнятся. `_id` (22 символа base64) у всех нод/компонентов в сценах, `""` — в префаб-файлах. `_euler` ↔ `_lrot`: рантайм читает `_lrot`, формула `Quat.fromEuler` — YZX (`src/utils/math3d.js`).
- **Префаб-инстансы сериализуются свёрнуто**: нода-заглушка `{_parent, _prefab, __editorExtras__}` (без `_name`/`_children`) + `cc.PrefabInfo {fileId = fileId корня исходника, instance}` + `cc.PrefabInstance {propertyOverrides, mountedChildren, ...}`. Всё состояние — в `CCPropertyOverrideInfo {targetInfo: {localID: [fileId]}, propertyPath, value}`; внутренние ноды инстанса в файле не существуют.
- Корневая `cc.Scene._prefab` — **реестр инстансов** (`nestedPrefabInstanceRoots` в DFS-порядке иерархии, `targetOverrides`); при добавлении/удалении/перемещении инстансов он обновляется согласованно.
- `fileId` уникален только в definition-scope префаб-файла (инстансы одного префаба легитимно дублируют); `_id` уникален в файле.
- Ссылки на ассеты: `{__uuid__: <полный dashed-UUID>, __expectedType__}`. Суб-ассеты изображений: `<uuid>@f9941` = spriteFrame, `<uuid>@6c48a` = texture2D; у моделей `@<5 hex>` — gltf-mesh/gltf-material/gltf-scene/gltf-animation.
- AABB меша: `library/<2 hex>/<uuid>@<subId>.json` → `_struct.minPosition/maxPosition`; fallback для `.glb` — glTF accessors POSITION min/max. Для `.fbx` без `library/` кэша AABB недоступен. Скомпилированный gltf-scene префаб модели тоже лежит в `library/` — без него модель можно инстанцировать только через `.prefab`.
- MeshRenderer с `_materials: [null]` рендерится **невидимым** — материал обязателен (build_prefab предупреждает).
- Новый `.prefab` требует `.meta` с UUID — генерируется сразу (`importer: prefab`), редактор уважает готовый UUID, на префаб можно ссылаться немедленно.
- designResolution: `settings/v2/packages/project.json` → `general.designResolution`; версия движка: `package.json` игры → `creator.version`; физика — `settings/v2/packages/` (`project.json` → `physics`, активный движок в `engine.json`).
- Спрайт-мета: subMetas с rect/trim/9-slice границами; PNG в 3D-проекте может быть импортирован как `type: "texture"` без sprite-frame вовсе.

Известные ограничения (кандидаты на развитие): multi-hop overrides внутрь вложенных инстансов, создание `targetOverrides`, editor-bridge для live-режима, CLI-валидация для CI.

## Тестирование

```bash
npm test                 # Node.js built-in test runner
npm run test:coverage
```

`test/fixtures/golden/` — неизменённые файлы, сохранённые редактором из реального проекта: round-trip тесты слоя записи обязаны воспроизводить их **байт-в-байт**, поэтому их нельзя переформатировать или править руками. `test/fixtures/mock-project/` — миниатюрный Cocos-проект с реальными метами для тестов ассетов и записи.

## Пример вывода

```
● game
  ● Level
    ● PlayerInfo @(13.5,0,-15.3)
      ◆ RigidBody
      ◆ PlayerController {moveSpeed=4}
      ◆ Inventory
      ● PlayerGas
        ◆ ItemStack {resourceType=1}
```

**Легенда:**
- `●` активный / `○` неактивный
- `◆` enabled / `◇` disabled
- `@(x,y,z)` позиция
- `{props}` свойства скрипта
- `→Name` ссылка на нод

## Extending

### Custom Noise Types

```javascript
import { TypeFilter } from 'plbx-cocos-mcp';

const filter = new TypeFilter();
filter.addNoiseTypes(['cc.MyCustomNoise', 'cc.AnotherNoise']);
```

### Custom Node Filters

```javascript
import { NodeFilter } from 'plbx-cocos-mcp';

const filter = new NodeFilter();
filter.addFilter((node, depth) => {
    // Filter out nodes starting with "_"
    return node._name?.startsWith('_');
});
```

## License

Apache-2.0 — see [LICENSE](LICENSE).

## Links

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Cocos Creator](https://www.cocos.com/en/creator)
