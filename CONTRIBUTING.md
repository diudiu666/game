# 参与贡献

先谢谢你有兴趣。这个项目是从一份技术架构文档长出来的可玩原型，**最缺的是试玩反馈和数值论证**，其次才是代码行数——所以别担心「只提了个 issue 没写代码」，那也算贡献。

## 环境

| 需要 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 18（CI 用 22，见 `.nvmrc`） | 只需要 `node`，没有构建步骤 |
| 浏览器 | 可选 | 只有 `tools/` 里 15 个「浏览器验收」脚本需要 |
| 数据库 / 打包器 | 不需要 | 地图是运行时算的，没有静态资源构建 |

```bash
git clone https://github.com/diudiu666/game.git
cd game
npm install
npm start          # → http://localhost:5173
```

`npm install` 会把 `playwright-core` 一起装上（devDependency，约 3MB）；不跑浏览器测试的话它不会被用到。

## 改之前先知道这几条

1. **数值只在 `src/game.js` 的 `CONFIG` 里改。** 别的地方不许出现魔法数字。改完请用 `tools/` 里的对照脚本说明影响，而不是「我感觉这样更爽」。
2. **结算只在服务端。** 联机时客户端只负责显示和「这块地我打不打得动」的高亮，任何归属变更都必须走 `server/index.mjs`。前端改代码抢不了地，这是设计目标，别破坏它。
3. **`src/game.js` 不许依赖 DOM。** 它同时跑在浏览器和 Node 里（无头模拟、CI 断言都靠这个）。需要新增逻辑时先问一句：这段能不能被 `node` 直接 import 测试？
4. **端口是 5173。** 通用 `PORT` 环境变量刻意不生效，避免别的工具把正式服顶走；要换端口用 `node server/index.mjs 5180` 或 `TD_PORT=5180`。

## 测试

脚本分三类，按依赖从轻到重：

**纯逻辑（不需要服务器、不需要浏览器，秒级）**

```bash
node tools/connectivity.mjs    # 200 张随机图的连通性 / 孤立区域
node tools/capital.mjs         # 都城、战损、斩首：28 项断言
node tools/sim.mjs             # 无头 AI 对局，调数值时的主视图
node tools/capsweep.mjs        # 参数扫描：都城守备 × 战损 × 斩首倾向
node tools/capstudy.mjs        # 上限 / 兵营到底有没有卡住人
node tools/upgradevalue.mjs    # 四条发育路线的最终权重对照
```

**协议（要先起服务器）**

```bash
npm start &                                        # 或另开一个终端
node tools/nettest.mjs                             # 进房 / 开局 / 指令校验 / 断线续座
node tools/resetcheck.mjs                          # 结算后自动回大厅
```

**浏览器（要先起服务器，再准备一份 Chromium）**

```bash
node tools/pickcheck.mjs       # 62 块地能不能点中自己
node tools/nameplates.mjs      # 名牌落点、字号、手机端不裁切
node tools/solowin.mjs         # 单人清图必须弹结算
node tools/fx.mjs              # 占领特效 + 对象泄漏
node tools/capitalshot.mjs     # 都城标记 / 斩首横幅
node tools/mplay.mjs 4         # 4 个浏览器同房互抢
```

浏览器脚本统一走 `tools/lib/harness.mjs` 找 Chromium，顺序是：`CHROME_PATH` → playwright 自报路径 → 本机 playwright 缓存（取版本号最大的）→ 系统 Chrome/Edge。装不上就按报错里的提示做，或者：

```bash
npx playwright-core install chromium
# 已经有系统 Chrome 的话，也可以直接指定：
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tools/pickcheck.mjs
```

想重新生成 README 头图：`node tools/hero.mjs`（会开一局单人、占十几块地、悬停后截图到 `docs/hero.png`）。

## 提交

- 一个 PR 只做一件事；顺手改的格式问题请单独提。
- commit message 中英文都行，重点写**为什么**，而不是「改了 xxx.js」。
- 动数值的 PR 请附上对照数据（比如 `tools/capsweep.mjs` 前后两版输出的淘汰率和平均时长）。
- 新增玩法请同时补一条能被 `node` 跑起来的断言，测试比说明文档更不容易过期。

## 语言

代码注释、提交信息、文档以中文为主；issue 和 PR 用中文或英文都可以，都会有人看。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。有安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。
