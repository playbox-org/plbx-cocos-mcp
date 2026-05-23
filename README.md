# PLBX Cocos MCP Server

MCP (Model Context Protocol) сервер для работы со сценами Cocos Creator в AI coding assistants.

> **PLBX** = Playbox - internal tooling for game development workflows

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

## Что делает

Конвертирует тяжёлые файлы сцен Cocos Creator (~700KB, 40k строк JSON) в компактные семантические графы (~20KB).

**Компрессия: 36:1**

### MCP Tools

| Tool | Описание |
|------|----------|
| `query_scene_graph` | Минифицированная иерархия сцены |
| `list_scene_scripts` | Список TypeScript скриптов |
| `find_scene_nodes` | Поиск нодов по паттерну (regex) |

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

### Claude Code

`.mcp.json` в корне проекта:

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

## CLI Usage

```bash
# Вывод в консоль
node bin/scene-minifier.js assets/Scenes/game.scene

# Сохранение в файл
node bin/scene-minifier.js assets/Scenes/game.scene -o graph.txt

# JSON формат
node bin/scene-minifier.js assets/Scenes/game.scene --json > scene.json
```

## Архитектура (SOLID)

```
src/
├── core/                    # Core domain logic
│   ├── SceneParser.js       # S: Parse scene JSON
│   ├── ScriptResolver.js    # S: UUID → script name mapping
│   ├── NodeTreeBuilder.js   # S: Build minified tree
│   ├── PropertyExtractor.js # S: Extract component properties
│   └── SceneMinifier.js     # D: Orchestrator (DI)
├── filters/                 # O: Extensible filters
│   ├── TypeFilter.js        # Filter noise types
│   └── NodeFilter.js        # Filter skeleton bones
├── formatters/              # I: Output formatters
│   ├── Formatter.js         # Base interface
│   ├── TextFormatter.js     # Text output
│   ├── JsonFormatter.js     # JSON output
│   └── StatsFormatter.js    # Statistics
├── tools/                   # L: MCP tools
│   ├── BaseTool.js          # Base class
│   ├── QuerySceneGraph.js
│   ├── ListSceneScripts.js
│   └── FindSceneNodes.js
└── server/
    └── McpServer.js         # MCP protocol handler
```

### SOLID Principles Applied

- **S**ingle Responsibility: Each class has one job
- **O**pen/Closed: Filters extensible via `addNoiseTypes()`, `addFilter()`
- **L**iskov Substitution: All tools/formatters interchangeable
- **I**nterface Segregation: Minimal `Formatter` interface
- **D**ependency Inversion: `SceneMinifier` accepts dependencies

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
