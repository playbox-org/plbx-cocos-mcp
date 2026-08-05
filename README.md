# PLBX Cocos MCP Server

MCP (Model Context Protocol) сервер для работы со сценами и префабами Cocos Creator 3.x в AI coding assistants: чтение компактных семантических графов и **корректное редактирование/создание** сцен и префабов семантическими операциями.

> **PLBX** = Playbox - internal tooling for game development workflows

## Что делает

- **Чтение**: конвертирует тяжёлые файлы сцен (~700KB, 40k строк JSON) в компактные семантические графы (~20KB). Компрессия ~36:1.
- **Запись**: lossless-слой поверх формата редактора — батчи семантических операций с валидацией инвариантов и атомарной записью. Канон сериализации верифицирован **байт-в-байт** с выводом Cocos Creator 3.8.7 на golden-корпусе реального проекта.
- **Создание**: `build_prefab` разворачивает компактный спек (~30 строк) в полный корректный `.prefab` + `.meta` (~400–800 токенов вместо 15–50k при ручной генерации JSON); `build_animgraph` так же собирает анимационные графы (`.animgraph`), `build_terrain` — бинарные террейны (`.terrain`: блоки, высоты из heightmap'а, палитра текстур); `create_asset_meta` генерирует `.meta` оффлайн для ассетов, созданных вне редактора (скрипты, материалы, картинки, звук) — без «откройте редактор» для импорта.
- **Измерения**: AABB поддеревьев, точная арифметика fit-scale, линт ассетов.

LLM никогда не редактирует `.scene`/`.prefab` напрямую: файл не влезает в контекст, а `__id__` — индексы массива, вставка в середину ломает все последующие ссылки. `.terrain` не редактируется текстом уже потому, что это бинарь. Только семантические MCP-операции.

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

## MCP Tools (22)

### Чтение

| Tool | Описание |
|------|----------|
| `query_scene_graph` | Минифицированная иерархия сцены |
| `query_prefab_graph` | Минифицированная иерархия префаба |
| `query_animgraph` | Компактная сводка анимационного графа (`.animgraph`): переменные, стейты по слоям (клипы — именами), переходы с условиями (`Speed > 0.1`, `trigger Jump`, `[exit]`) и длительностями |
| `query_terrain` | Разбор террейна (`.terrain`): геометрия (размер в метрах, блоки, tileSize, сетка вершин, weight/light map), статистика высот, палитра слоёв с текстурами по именам, использование слотов по блокам. Сэмплинг: `heightAt` («мой объект стоит на земле?»), `weightAt` («какой слой здесь закрашен?»), `exportHeights` (дамп сетки высот, в т.ч. `format: "map"` — ASCII-карта выше/ниже порога). Ридауты для правки существующего рельефа: `contourAt` — где проходит изо-контур высоты (край плато, подошва скалы, линия воды); `slope` — уклон в градусах с максимумом, `maxStep` (метрика залома) и распределением по полосам |
| `list_scene_scripts` | Список TypeScript скриптов сцены |
| `find_scene_nodes` | Поиск нодов по паттерну имени (regex), по компоненту (`component`: тип `cc.*` или имя скрипта; mounted-компоненты инстансов тоже матчатся) и/или по области (`region: {x,z,width,depth}` либо `{center,radius}` — world-XZ след AABB, печатается вместе с матчем). Область — в МЕТРАХ, поэтому поддеревья `cc.Canvas` из неё исключены (их раскладка в пикселях), число исключённых — в футере |
| `inspect_node` | Полное поддерево конкретного нода без фильтрации; asset-ссылки резолвятся в имена (`(embedded)` для встроенных fbx-материалов, `builtin:<имя>` для движковых). На свёрнутом префаб-инстансе разворачивает внутренности исходного префаба (read-only, с target-путями для `set_instance_property`), список overrides и секции **Mounted components / Mounted children** — добавленное поверх инстанса, с полными свойствами |

### Интроспекция проекта и ассетов

| Tool | Описание |
|------|----------|
| `get_project_info` | Версия движка, designResolution, слои, физика + self-check корня проекта (резолвнутый путь, наличие `assets/` и `library/`, число индексированных ассетов) — первое, что стоит проверить при странных результатах чтения |
| `get_asset_info` | Детали ассета: спрайт (rect/trim/9-slice), меш (AABB), префаб, материал, террейн; вход — путь или UUID (полный/сжатый/суб-ассет). UUID встроенных ассетов движка отвечают карточкой «engine built-in» |
| `list_assets` | Каталог ассетов с фильтрами (тип/папка/маска) и выбором формы вывода: `grouped` (по умолчанию — папка заголовком, тип выносится в шапку когда однороден), `summary` (только counts по типам и папкам — обзор проекта без перечисления), `flat`/`json`. UUID по умолчанию не печатается (путь резолвится всюду, где резолвится UUID); `uuid: "compressed"`/`"full"` по запросу |
| `find_asset_references` | Обратный поиск «кто использует ассет»: скан сцен/префабов с атрибуцией `файл → путь ноды → компонент.свойство` (материалы/анимации — на уровне файлов, `.terrain` — до слоя и слота карты: `terrain layer 1 .detailMap`). Неизвестные UUID классифицируются: ассет проекта / engine built-in / битая ссылка |

### Запись

| Tool | Описание |
|------|----------|
| `apply_edits` | Батч семантических правок сцены/префаба (см. ниже) с валидацией, `dryRun` и атомарной записью |
| `validate_document` | Проверка инвариантов файла (ссылки, двунаправленность parent/children и component/node, `_id`/`fileId`, ассеты, euler/quat, wrapper-правило) |
| `build_prefab` | Создание нового `.prefab` (+`.meta` с UUID) из компактного спека |
| `build_animgraph` | Создание нового `.animgraph` (+`.meta` с UUID) из компактного спека: variables/states/transitions; Entry/Exit/Any и event-биндинги генерируются автоматически, условия — строками (`"Speed > 0.1"`, `trigger`) |
| `build_terrain` | Создание нового `.terrain` (+`.meta` с UUID) из компактного спека: `blockCount`/`tileSize`/`weightMapSize`, высоты (плоские, inline-строки метров, 16-битный `.raw` или grayscale `.png`), палитра слоёв с текстурами. Пишет бинарь V8 — тот же, что редактор |
| `edit_terrain` | Батч операций над существующим `.terrain` — всё или ничего, `dryRun`, атомарная запись. 8 ops: `set_info` (resize с сохранением перекрытия), `set_layer`/`remove_layer` (палитра), `set_heights`/`adjust_heights`/`smooth_heights` (лепка), `paint_layer` (веса слоя с ренормализацией), `set_block_layers`. Поля компонента `cc.Terrain` (ассет, тени, PBR, LOD) — данные сцены, они через `apply_edits` |
| `create_asset_meta` | Оффлайн-генерация `.meta` для ассетов, созданных вне редактора (скрипты, `.mtl`, `.anim`, картинки, звук, папки): редактор доверяет принесённому meta и сохраняет UUID при импорте, так что ссылаться на ассет можно сразу. Идемпотентен, метит и цепочку родительских папок. Модели `.fbx/.glb/.gltf` — только через редактор |

**Регион и маска `edit_terrain`.** Все операции с `region` делят одну маску:

- `shape` — `rect`, `ellipse` или `band`. Band идёт по изо-контуру высоты (`contour` + `inner`/`outer` — знаковые расстояния до контура в **метрах по земле**, не высоты); прямоугольник для band — только bounding box.
- `falloff` + `profile` (`linear`/`smooth`/`cosine`) — фактор равен 0 ровно **на** границе региона и полной амплитуде `falloff` метров внутрь, поэтому спад не может оказаться обрезанным маской. Band сходит на нуль только поперёк своей толщины.
- Высотные операции ещё принимают `clamp` — `raise-only`/`lower-only` (`max`/`min` с существующей поверхностью), что делает правку идемпотентной по краям.

### Измерения и гигиена

| Tool | Описание |
|------|----------|
| `get_node_bounds` | World/local AABB поддерева (меши, UITransform, свёрнутые префаб-инстансы); local — готовые center/size для BoxCollider; `perChild` — по одному world-AABB на каждого прямого ребёнка (у свёрнутого инстанса дети берутся из исходного префаба, плюс mounted-ноды инстанса — они помечены `(mounted)` и входят и в общий AABB) |
| `compute_fit_scale` | Точный масштаб под целевой размер (fit-inside по нескольким осям), готовый op в ответе |
| `compute_rotation` | Точная математика поворотов: `convert` (quat↔euler YZX), `compose` («повернуть на N° вокруг мировой/локальной оси» — с учётом поворотов родителей при `filePath+node`), `orient` («локальная ось A смотрит в мировое направление D», опц. `up`); в ответе euler+quat+готовый op |
| `lint_assets` | Криптоимена (`mesh_001`, `Sprite(2)`), разброс размеров моделей, нарушения wrapper-правила, консистентность материалов (встроенный fbx-материал vs материал проекта на одном меше), слои террейнов (текстура слоя не резолвится; слой назначен блокам, но его канал весов нулевой везде). Террейновые находки `validate_document` не видит — их id живут в бинаре |

## Редактирование сцен

`apply_edits` принимает батч операций — всё или ничего: ops → перенумерация → валидация → атомарная запись только валидного результата. В ответе — минифицированные поддеревья затронутых участков. `dryRun: true` показывает результат без записи.

Пятнадцать операций:

- `set_node_property` — name/active/layer/mobility/position/rotation/scale (euler автоматически синхронизирует кватернион)
- `add_node`, `remove_node` (+ чистка реестра инстансов и внешних ссылок), `reparent`
- `add_component` — шаблон `cc.*` или кастомный скрипт по имени. Каталог из ~46 встроенных шаблонов: UI/2D (UITransform, Sprite, Label, RichText, Button, Widget, Canvas, SafeArea, Mask, Graphics, Layout, ProgressBar, Slider, UIOpacity, BlockInputEvents, RenderRoot2D, Sorting, UIMeshRenderer), 3D (MeshRenderer, SkinnedMeshRenderer, SpriteRenderer, Line, Billboard, Camera, DirectionalLight, SphereLight, SpotLight, Animation, SkeletalAnimation, AnimationController, AudioSource, Terrain), физика 3D+2D (RigidBody, Box/Sphere/Capsule/Cylinder/Mesh/Terrain-Collider, RigidBody2D, Box/Circle/Polygon-Collider2D), партиклы (ParticleSystem со всеми модулями и renderer, ParticleSystem2D) — наборы полей сверены с редакторскими файлами боевых проектов, значения — дефолты движка 3.8.7. Обязательные компаньоны добавляются автоматически, как в редакторе (`cc.Sprite` тянет `cc.UITransform`)
- `remove_component` — внешние ссылки на компонент блокируют операцию (`force: true` обнуляет их); `cc.UITransform` защищён, пока на ноде есть зависимые UI-компоненты. На префаб-инстансе mounted-компонент удаляется физически, а компонент исходного префаба (`target` — путь внутри него) — записью в `removedComponents` инстанса
- `set_component_property` — формы значений `$node`/`$asset`/`$component`, слияние value-типов; `$node`/`$component` могут указывать **внутрь** свёрнутого префаб-инстанса (см. targetOverrides в format notes). На стабе `component` адресует mounted-компоненты инстанса (неоднозначность — через `target: "<mount path>"` или `componentIndex`); свойства компонентов исходного префаба — через `set_instance_property`
- `set_asset_ref` — ссылка на ассет по пути/UUID/`uuid@subId`
- `insert_array_element`, `remove_array_element` — изменение **состава** массива (`CCClass[]` вроде `entries: CardEntry[]`, массивы value-типов `cc.Vec2[]`, скалярные): insert клонирует соседний элемент как скелет и накрывает его полями из `value`, remove вырезает элемент и собирает его владеемое поддерево GC. Правка **полей** существующего элемента — это `set_component_property`
- `instantiate_prefab` — свёрнутый инстанс (стаб + overrides), принимает `.prefab`, модель (gltf-scene из `library/`) или `model@subId`
- `set_instance_property` / `remove_instance_override` — overrides инстансов; `target` — путь внутри исходного префаба; значения-ссылки поддерживаются: `$node`/`$component` на plain-объекты сцены сериализуются в значение override, ссылки внутрь инстансов — редакторской формой targetOverride с `sourceInfo`
- `restore_instance_component` — откат `remove_component` на инстансе (удаляет запись из `removedComponents`)
- `prune_dangling_overrides` — ремонт: удаляет мёртвые записи `cc.TargetOverrideInfo` (обрывки редакторских переработок — `source: null`, цель — отвязанная нода), которые движок игнорирует при загрузке. Идемпотентна; редакторские формы (`target: null`) не трогает — `validate_document` сам подсказывает эту операцию, когда находит такие записи

**Адресация нод** — путь (`Canvas/Panel/BuyBtn`, `Name[i]` для одноимённых) или стабильный `_id` ноды. Никогда `__id__` — индексы съезжают после каждой записи.

**Политика префабов**: правь исходный ассет, не инстанс — инстансы наследуют изменения. Внутренности инстансов в файле не существуют (свёрнутая сериализация) и правятся только через overrides; читать их можно — `inspect_node` на инстансе разворачивает исходный префаб с target-путями и текущими overrides. Ссылки `@property` **на объекты внутри инстанса** проставляются обычным `set_component_property`: `{"$node": "Stub/Inner/Node"}` (путь продолжается внутрь стаба) или `{"$component": {node: "Stub", target: "Inner/Node", type: "T"}}` — сериализуются редакторской формой targetOverride.

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
│   ├── builtins.js          # Engine built-in UUID (db://internal) → имя/карточка
│   └── ProjectInfoReader.js # Версия движка, настройки проекта
├── document/                # Запись (lossless)
│   ├── SceneDocument.js     # load → mutate → validate → save; канон = DFS-перенумерация
│   ├── operations.js        # Семантические операции
│   ├── instances.js         # Свёрнутые префаб-инстансы и overrides
│   ├── targetOverrides.js   # Ссылки @property внутрь свёрнутых инстансов
│   ├── ComponentTemplates.js# Полные шаблоны компонентов 3.8.x
│   ├── Validator.js         # Инварианты (ошибки) + конвенции (warnings)
│   ├── PrefabBuilder.js     # Спек-компилятор build_prefab
│   ├── AnimGraphBuilder.js  # Спек-компилятор build_animgraph
│   ├── TerrainBuilder.js    # Спек-компилятор build_terrain (+ резолв текстур слоёв)
│   ├── terrainOps.js        # Семантические операции над .terrain (8 ops + общая маска региона)
│   ├── MetaGenerator.js     # Оффлайн-генерация .meta (create_asset_meta, меты билдеров)
│   ├── AnimGraphReader.js   # Семантическая модель + текст-рендер .animgraph
│   ├── Bounds.js            # AABB поддеревьев
│   └── MiniTree.js          # Компактные поддеревья для ответов
├── filters/                 # Расширяемые фильтры шума
├── formatters/              # Text / Json / Stats
├── utils/                   # uuid (компрессия, nameToId), glb, math3d (quat/euler YZX, mat4),
│                            # terrainBin (чтение/запись .terrain V8), heightmap (png/raw/inline),
│                            # terrainContour (изо-контуры, знаковая дистанция, уклон/залом),
│                            # fsAtomic (атомарная запись бинарей), fileId
├── assets-data/             # builtins-3.8.json — engine built-in UUID (harvest: scripts/harvest-builtins.mjs)
├── tools/                   # 22 MCP-тула (BaseTool + реестр index.js)
└── server/McpServer.js      # MCP protocol handler (stdio)
```

## Формат Cocos Creator 3.x — верифицированные заметки

Проверено кодом на golden-корпусе реального проекта (Cocos Creator 3.8.7, 3D): сцена 1.2MB (3549 объектов) + 4 префаба; round-trip и приёмка в редакторе — байт-в-байт.

- Файл = плоский JSON-массив; `{"__id__": N}` — индекс в массиве; `__type__` кастомных компонентов — сжатый UUID (первые 5 hex как есть + 27 hex пакуются по 3 hex → 2 base64-символа; алгоритм в `src/utils/uuid.js`).
- **Порядок сериализации** — ключ ко всей записи: порядок объектов = depth-first порядок первого посещения при обходе всего графа ссылок от объекта 0. Кросс-ссылки «вытягивают» объекты вперёд. Вывод = `JSON.stringify(arr, null, 2)` без завершающего `\n`.
- Нода: `_parent`/`_children` двунаправленны; у компонентов обратная ссылка `node`; value-типы (`cc.Vec3` и т.п.) инлайнятся. `_id` (22 символа base64) у всех нод/компонентов в сценах, `""` — в префаб-файлах. `_euler` ↔ `_lrot`: рантайм читает `_lrot`, формула `Quat.fromEuler` — YZX (`src/utils/math3d.js`).
- **Префаб-инстансы сериализуются свёрнуто**: нода-заглушка `{_parent, _prefab, __editorExtras__}` (без `_name`/`_children`) + `cc.PrefabInfo {fileId = fileId корня исходника, instance}` + `cc.PrefabInstance {propertyOverrides, mountedChildren, ...}`. Всё состояние — в `CCPropertyOverrideInfo {targetInfo: {localID: [fileId]}, propertyPath, value}`; внутренние ноды инстанса в файле не существуют.
- Корневая `cc.Scene._prefab` — **реестр инстансов** (`nestedPrefabInstanceRoots` в DFS-порядке иерархии, `targetOverrides`); при добавлении/удалении/перемещении инстансов он обновляется согласованно.
- **Ссылки внутрь свёрнутых инстансов** (`cc.TargetOverrideInfo`, верифицировано на golden-корпусе: 43 в сцене + 4 в префабе): ссылка «компонент → объект внутри инстанса» **не** сериализуется как `{"__id__"}` — свойство у источника пишется `null` (или ключ опускается редактором вовсе), а в реестровом PrefabInfo (`targetOverrides`) появляется `cc.TargetOverrideInfo {source: <компонент>, sourceInfo: null, propertyPath: ["prop"] | ["arr", "0"] (сегменты — всегда строки), target: <нода-стаб>, targetInfo: cc.TargetInfo {localID: [<fileId цели в исходном префабе>]}}`. При загрузке движок резолвит `target` → корень инстанса → `localID` и перезаписывает `null`. Живой override **затеняет** сериализованное значение — при перезаписи свойства обычным значением запись targetOverride обязана удаляться (иначе тихий откат при загрузке); `apply_edits` делает это автоматически. Формы `target: null` (резолв от корня документа) и multi-hop `localID` встречаются в editor-файлах — читаются и сохраняются как есть, но не генерируются.
- **Источник внутри инстанса** (`sourceInfo != null`, 24 из 43 записей golden-сцены): когда ссылку хранит компонент, сам лежащий в свёрнутом инстансе, `source` = **нода-стаб** этого инстанса, `sourceInfo` = `cc.TargetInfo {localID: [<CompPrefabInfo.fileId компонента-источника>]}` — движок резолвит источник через targetMap инстанса (`applyTargetOverrides`, исходники 3.8.7). Так пишет `set_instance_property` со значением `$node`/`$component`, указывающим внутрь инстанса (этого же или другого). Ссылка из инстанса на **plain-объект сцены** — другой механизм: обычный `{"__id__"}` прямо в значении `CCPropertyOverrideInfo` (golden: `playerGoldStorage`, 9 записей).
- **`removedComponents`** (удаление компонента с инстанса): массив ссылок на `cc.TargetInfo {localID: [<CompPrefabInfo.fileId>]}` в `cc.PrefabInstance` — форма выведена из `applyRemovedComponents` в исходниках движка 3.8.7 (движок резолвит компонент через targetMap и снимает его с ноды); **editor re-save верификация pending** — в golden-корпусе массив всегда пуст. `remove_component` на стабе дедуплицирует записи, чистит property-overrides умершего компонента и его исходящие targetOverrides; входящие targetOverrides блокируют операцию без `force: true`.
- **Mounted components/children** (компоненты/ноды, добавленные поверх инстанса; верифицировано на golden-сцене: 8 × `cc.MountedComponentsInfo` c 10 компонентами + 1 × `cc.MountedChildrenInfo`): `cc.PrefabInstance.mountedComponents[] → cc.MountedComponentsInfo {targetInfo → cc.TargetInfo {localID: [fileId узла монтирования в исходном префабе]}, components: [{__id__}]}` — компоненты лежат **обычными сериализованными объектами в файле сцены** (`node` → нода-стаб, `__prefab: null`, `__editorExtras__.mountedRoot` → стаб). `MountedChildrenInfo.nodes` — обычные `cc.Node` с `_parent: null`. Ссылки в свойствах mounted-компонента на plain-объекты сцены — прямые `{"__id__"}` (golden: `pipeControllers`); ссылки внутрь инстансов — обычный targetOverride-механизм с `source` = mounted-компонент (форма B1). Поэтому `set_component_property`/`set_asset_ref`/`remove_component` работают на них как на обычных нодах — не хватало только адресации (**editor re-save верификация записи pending**); **создание** новых mounted-записей через MCP не реализовано.
- **Engine built-ins**: сцены свободно ссылаются на UUID из внутренней базы редактора (`db://internal` — примитивы `primitives.fbx`, default-материалы/effects/spriteFrames/шрифты), которых нет ни в одном `.meta` проекта. Статическая таблица `src/assets-data/builtins-3.8.json` (407 ассетов, собрана `scripts/harvest-builtins.mjs` из установленного Cocos Creator 3.8.7) резолвит их в имена: read-вывод помечает `builtin:<имя>`, `get_asset_info` отвечает карточкой, валидатор не считает их отсутствующими — warning «not found» остаётся только для действительно подозрительных UUID.
- `fileId` уникален только в definition-scope префаб-файла (инстансы одного префаба легитимно дублируют); `_id` уникален в файле.
- Ссылки на ассеты: `{__uuid__: <полный dashed-UUID>, __expectedType__}`. Суб-ассеты изображений: `<uuid>@f9941` = spriteFrame, `<uuid>@6c48a` = texture2D; у моделей `@<5 hex>` — gltf-mesh/gltf-material/gltf-scene/gltf-animation.
- AABB меша: `library/<2 hex>/<uuid>@<subId>.json` → `_struct.minPosition/maxPosition`; fallback для `.glb` — glTF accessors POSITION min/max. Для `.fbx` без `library/` кэша AABB недоступен. Скомпилированный gltf-scene префаб модели тоже лежит в `library/` — без него модель можно инстанцировать только через `.prefab`.
- MeshRenderer с `_materials: [null]` рендерится **невидимым** — материал обязателен (build_prefab предупреждает).
- Новый `.prefab` требует `.meta` с UUID — генерируется сразу (`importer: prefab`), редактор уважает готовый UUID, на префаб можно ссылаться немедленно.
- **Оффлайн-генерация `.meta` легитимна и масштабируется**: ассет идентифицируется только по UUID из meta; файл, принесённый **вместе с** meta, сохраняет UUID при импорте; `library/` — регенерируемый кеш, писать его не нужно. UUID — чистый random v4. Реестр importer'ов (расширение → `importer`/`ver`) снят с app.asar 3.8.7 (`engine-extends` contributions). SubId суб-ассетов = `nameToId(name)` — 5 символов md5-hex по позициям 0/6/16/25/31 (порт из npm `@cocos/asset-db`, верифицирован: `texture`→`6c48a`, `spriteFrame`→`f9941`). Не генерируются только модели (`.fbx/.glb/.gltf`): их userData зависит от содержимого, а MCP сам читает library-артефакты моделей.
- **`.animgraph`** — тот же плоский JSON-массив с head `cc.animation.AnimationGraph` (канон DFS-нумерации и stringify распространяется на него, round-trip байт-в-байт на эталоне); `_variables` — объект-map (имя → `{__id__}`), не массив. Служебные Entry/Exit/Any стейты присутствуют всегда; у Motion пара event-биндингов (in/out), у AnimationTransition — пара start/end. Enum'ы верифицированы по исходникам движка 3.8.7: `BinaryCondition.operator` — `== != < <= > >=` (0–5), `PlainVariable._type` — float 0 / boolean 1 / integer 3, триггер — отдельный `TriggerVariable` (`_flags: 2` у редактора). `.meta`: `importer: "animation-graph"`, `ver: "1.2.0"`.
- **`cc.animation.AnimationController`** сериализует ссылку на граф **дважды** — `_graph` и `graph` (getter/setter-пара): запись через `set_asset_ref`/`set_component_property` синхронизирует оба поля. Контроллер обычно ставится на корень скелета внутри модели — на свёрнутый инстанс его не поставить (нужна распаковка модели в редакторе).
- **`.terrain`** — не JSON, а сырой нативный бинарь (little-endian, плотная упаковка без выравнивания). Верифицировано на editor-save реального проекта (`guligames-legendale-c7`, Cocos Creator 3.8.8; каталог `cocos/terrain/` в 3.8.7 и 3.8.8 идентичен — одна реализация покрывает оба): round-trip read→write — **байт-в-байт** на эталоне 131 072 B и на 2048-байтном `default.terrain`. Заголовок: `version` i32 (`0x01010008` = V8, единственная версия, которую пишут редакторы 3.8.x), `tileSize` f64, `blockCount` i32×2, `weightMapSize` i16, `lightMapSize` i16. Дальше четыре массива вида «i32 count + элементы»: `heights` u16 (N = `(bc0*32+1)*(bc1*32+1)`), `normals` f32, `weights` u8 (N = `(wms*bc0)*(wms*bc1)*4`), `layerBuffer` i16 (N = `bc0*bc1*4`), и в конце `layerInfos` — i32 count + записи `slot` i32, `tileSize` f64, `detailMapId` строка, `normalMapId` строка (`""` если нет), `roughness` f64, `metallic` f64, где строка = i32 число символов + 1 байт на символ (ASCII; внутри лежат обычные `<uuid>@<subId>`, реальные данные — `@6c48a`, texture-суб-ассет картинки). Версионные гварды на чтении (`TerrainAsset._loadNativeData`): V1 — база, ≥V2 добавляет `layerBuffer`, ≥V3 — `layerInfos`, ≥V4 — `normalMapId`/`roughness`/`metallic`, ≥V6 — `normals`, ≥V7 — f64 вместо f32 (`tileSize` и слоевые `tileSize`/`roughness`/`metallic`), V8 — шаг высот 1/128 вместо 1/512 (V1–V7 миграются на загрузке); `0x01010111` — сентинел «пусто» (только заголовок, всё остальное — дефолты класса), это и есть шиппящийся редактором `default.terrain` (2048 B), который кладёт «Create → Terrain» до первой лепки. `tileSize` в файле лежит **неснапнутым**, снап `Math.floor(t*100)/100` движок делает на загрузке — writer сохраняет исходное значение, пока оно снапится в то же число (иначе read→write превратил бы `0.29` в `0.28`). **Хвостовое нулевое выравнивание — часть формата**: `_exportNativeData` отдаёт весь backing-буфер `TerrainBuffer`, чья capacity стартует с 2048 и удваивается, поэтому размер файла = наименьшее `2048·2^k ≥ payload` (эталон: 67 922 B payload в 131 072 B файле). Парсить только структурно: «последний ненулевой байт» врёт — последние 8 байт payload эталона это `metallic = 0.0`.
- **Высоты, веса и палитра `.terrain`**: высота — u16, метры = `(raw − 32768)/128`, диапазон −256…255.9921875 м, квант 7.8125 мм, плоский террейн = все сэмплы `32768`; сетка row-major, X быстрее; блок = 32×32 тайла = 33×33 вершины, размер по оси = `blockCount * 32 * tileSize` метров. `normals` редактор всегда пишет с count 0 (движок пересобирает их на загрузке, когда длина ≠ `vertexCount*3`) — writer тоже пишет 0. Веса — одна логическая RGBA8-карта на весь террейн, но движок использует её **поблочно**: на каждый блок заливается своя текстура `weightMapSize × weightMapSize` с `CLAMP_TO_EDGE`, семплируемая блочно-локальным uv, поэтому маппинг «метры → тексель» блочно-локальный и endpoint-inclusive (первый и последний тексель блока лежат на его границах, семплинг никогда не переходит шов); канал R смешивает слот 0 блока, G — 1, B — 2, A — 3. `layerBuffer` — 4 слота на блок (`blockId = yBlock*bc0 + xBlock`, `-1` = пусто), значения — индексы **палитры** (`Terrain._layerList`); количество смешиваемых слоёв движок берёт по **самому старшему** непустому каналу (`TerrainBlock.getMaxLayer`), так что `-1` под используемым каналом семплится как null-слой и рисуется ничем (слоты блока обязаны быть упакованы слева), а блок с единственным слотом weight-карту не читает вовсе. Палитра обязана быть плотной (`slot === индекс записи`): `_exportNativeData` перезаписывает бинарный `slot` индексом массива, а рантайм для файлов ≥V5 собирает палитру не из бинаря, а из library-JSON (бинарную таблицу читает только загрузка pre-V5) — при дыре два кодирования разошлись бы. Интерполяция высот (`getHeightAt`) и ресемплинг весов при resize — **не** билинейные: квад делится диагональю по `dx+dz<=1`, дальний угол экстраполируется (`m=(b+c)/2; d=2m−a`).
- **Импортер `.terrain`**: `.meta` — `importer: "terrain"`, `ver: "1.1.50"`, `files: [".bin", ".json"]`, пустые `subMetas`/`userData` (у terrain-импортера userData-конфига нет вообще). В `library/` кладётся **побайтовая копия** исходника (`<uuid>.bin`, сверено `cmp`) и `<uuid>.json` — обычный плоский сериализованный массив `cc.TerrainAsset {_native: ".bin", _layerInfos: [...]}` + `cc.TerrainLayerInfo`, зеркало бинарной таблицы слоёв. Высоты/веса/геометрия живут **только** в бинаре, JSON производный — поэтому оффлайн-проводка текстур внутри бинаря подхватывается реимпортом автоматически. Перезапись бинаря снаружи меняет mtime → asset-db делает чистый реимпорт, UUID берётся из `.meta` и сохраняется; MCP никогда не пишет `library/` и не трогает существующую мету. Границы редакторской панели Terrain (Vue-шаблон, снятый с `app.asar`): `tileSize` — `min 0.1`, шаг 0.1, один знак; `blockCount` W/H — целые ≥ 1; `weightMapSize` **и** `lightMapSize` — `ui-select` ровно из 128/256/512/1024. Движок же не проверяет ничего: `weightMapSize` — обычное `@serializable`-поле i16, проверки на степень двойки в `cocos/terrain/` нет нигде, а поблочная weight-текстура NPOT-безопасна (`LINEAR`, `CLAMP_TO_EDGE`, без мипмапов) — степень двойки это конвенция редактора, а не ограничение движка; наш гвард — степень двойки 4…1024 (нижняя граница ради дешёвых тестовых террейнов). Опасность: пока террейн открыт в редакторской панели Terrain, панель держит его целиком в памяти и её следующее сохранение перезаписывает файл целиком, молча затирая оффлайн-правку.
- **`cc.Terrain`** — 16 ключей в редакторском порядке: head (`__type__`, `_name`, `_objFlags`, `__editorExtras__`, `node`, `_enabled`, `__prefab`), затем 8 `@serializable`-полей в порядке объявления класса — `__asset`, `_effectAsset`, `_lightmapInfos`, `_receiveShadow`, `_useNormalmap`, `_usePBR`, `_lodEnable`, `_lodBias` — и `_id`. **Ключ ассета — `__asset`, с двойным подчёркиванием**: `@serializable`-член объявлен как `protected __asset`, а `_asset` — лишь getter/setter-фасад без сериализованного двойника (единственный такой случай в каталоге; ops принимают все три написания — `asset`, `_asset`, `__asset`). Дефолты движка: `_receiveShadow: false`, `_useNormalmap: false`, `_usePBR: false`, `_lodEnable: false`, `_lodBias: 0`, `_effectAsset: null`, `_lightmapInfos: []` (в реальной сцене `_receiveShadow: true` — правка пользователя, не дефолт). `_effectAsset: null` → движок берёт `TERRAIN_EFFECT_UUID = 1d08ef62-a503-4ce2-8b9a-46c90873f7d3` (legacy `terrain.effect`; surface-based `builtin-terrain.effect` — `a0fd9f76-74fe-423c-92d9-298906c189ba`); оба, как и `default.terrain`, `default_prefab/Terrain.prefab` и `default-layer-texture.jpg`, уже есть в таблице engine built-in'ов. `_lightmapInfos` заполняет только редакторский бейк лайтмапов (по записи на блок), и любой resize его инвалидирует (`Terrain.rebuild` вызывает `_resetLightmap(false)` безусловно, а не только при смене `blockCount`) — оффлайн он не генерируется никогда. Не сериализуются вообще: пер-блочные ноды `TerrainBlock` (`DontSave|HideInHierarchy`), `_layerList`, буферы, состояние LOD. Геометрия привязана к **началу координат ноды** (локальные X∈[0,width], Z∈[0,depth]), и шейдер прибавляет только мировую **позицию** ноды (`cc_matWorld[3]`) — поворот и масштаб ноды игнорируются, поэтому и AABB террейна считается по translation-only матрице. У редакторской ноды террейна `_objFlags: 512` — это `CCObject.Flags.LockedInEditor` (замочек в иерархии, чисто редакторский флаг; в движковом `default_prefab/Terrain.prefab` там 0), так что `add_node` с 0 корректен.
- **`cc.TerrainCollider`** — единственный способ сделать террейн коллайдящимся (`MeshCollider` heightfield не приготовит: меша у террейна нет). Своё `@serializable`-поле одно — `_terrain` (публичный `terrain` — просто аксессор, сериализованного двойника нет), поверх базовых полей `Collider`: `_material`, `_isTrigger`, `_center`. Ограничение движка: на **динамическом** `cc.RigidBody` terrain-коллайдер не поддерживается (warnID 9630) — только статическое тело или без тела вовсе; валидатор об этом предупреждает. Порядок полей шаблона выведен из 260+ редакторских сэмплов других коллайдеров (base → subclass), **editor re-save верификация pending**: редакторского сэмпла именно `cc.TerrainCollider` в корпусе нет.
- designResolution: `settings/v2/packages/project.json` → `general.designResolution`; версия движка: `package.json` игры → `creator.version`; физика — `settings/v2/packages/` (`project.json` → `physics`, активный движок в `engine.json`).
- Спрайт-мета: subMetas с rect/trim/9-slice границами; PNG в 3D-проекте может быть импортирован как `type: "texture"` без sprite-frame вовсе.

Известные ограничения (кандидаты на развитие): трансформ свёрнутого инстанса в READ-выводе берётся из его override'ов, поэтому инстанс **без** override'а трансформа печатается без позиции (истинное значение — TRS корня исходного префаба, а read-конвейер префабы не открывает; `get_node_bounds` открывает и учитывает), оверрайды **вложенных** нод внутри исходного префаба не применяются при измерении (ни в `#enterStub`, ни в цепочке до mount-ноды), multi-hop overrides внутрь вложенных инстансов, **создание** новых mounted components/children (чтение и правка существующих реализованы), editor re-save верификация `removedComponents`, `sourceInfo`-записей и правок mounted-компонентов на реальном проекте, editor re-save верификация террейнов, собранных/поправленных через MCP, и набора/порядка полей `cc.TerrainCollider`, бейк лайтмапов террейна и художественная ручная покраска весов (остаются редакторской работой), editor-bridge для live-режима, CLI-валидация для CI.

## Тестирование

```bash
npm test                 # Node.js built-in test runner
npm run test:coverage
```

`test/fixtures/golden/` — неизменённые файлы, сохранённые редактором из реального проекта (сцена 1.2MB + 4 префаба + `Player.animgraph`, а в `golden/terrain/` — `terrain.terrain` 131 072 B формата V8 вместе с его `.meta` и library-JSON, плюс шиппящийся редактором сентинел `default.terrain` 2048 B): round-trip тесты слоя записи обязаны воспроизводить их **байт-в-байт** (включая нулевое выравнивание бинаря), поэтому их нельзя переформатировать, править руками или пересохранять редактором. `test/fixtures/mock-project/` — миниатюрный Cocos-проект с реальными метами для тестов ассетов и записи (в нём же сгенерированный `assets/Maps/Terrain.terrain` для terrain-тестов).

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
