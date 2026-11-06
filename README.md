# swarm-draw

[![npm](https://img.shields.io/npm/v/swarm-draw.svg)](https://www.npmjs.com/package/swarm-draw)
[![CI](https://github.com/yunhai-dev/swarm-draw/actions/workflows/ci.yml/badge.svg)](https://github.com/yunhai-dev/swarm-draw/actions/workflows/ci.yml)
[![demo](https://img.shields.io/badge/demo-live-1a8cff)](https://yunhai-dev.github.io/swarm-draw/)

把「设计师现场画界面」这件事做成零依赖的 JS 库。

不是让元素一个个淡入登场，而是复刻真实的设计动作和**真实的设计顺序**：空白画板 → 拖出画板框 → 切结构 → 全灰线框 → 写文案 → 最后上色。一群纸飞机光标在页面上分头工作，每个区域由一只光标连续画完；底部 HUD 实时显示 `N agents · x / y layers`。

## 效果剧本：设计师实际是怎么做的

真实的设计流程里，顺序是硬约束 —— 布局没定就别写文案，文案没定就别上色，否则全要重做。库里的时间轴就是照这个顺序写的：

| # | 设计师做什么 | 画面上发生什么 | 状态类名 |
|---|---|---|---|
| 0 | 空白画板 | 区域**一个像素都不画**，只占位 | `sw-veiled` |
| 1 | 拉画板框（`F` + 拖动） | 空地上拖出描边 + **半透明填充** + 洋红对齐参考线，框内还没有内容 | `is-framing` |
| 2 | 松手，artboard 成立 | 框变成真实容器：白底/边框都在，但内部是空的、且**是灰的** | `sw-laying` + `sw-wireframe` |
| 3 | 切结构（由外向内） | 逐个拖出子块：父容器先、子元素后（DOM 前序 = 视觉顺序），全是灰块；有文案的块显示灰色文字条 | `sw-wire` / `sw-wire-text` |
| 4 | 布局定稿，停一下 | 整块灰线框静止，没有任何内容 | — |
| 5 | 写文案 | 文字条逐个换成真文字、真数字、真图标 | `sw-filled` |
| 6 | 上色精修 | 整块去饱和撤销，颜色/渐变/圆角/阴影一次性落下来（460ms） | 移除 `sw-wireframe` |
| 7 | 收工 | 控制点、徽标、参考线撤走；**当前视口画完后，所有光标礼花式绽放并离场** | 全部移除 |

两个"手势"细节，缺了就不像人在画：

- **按住 → 拖动 → 松手**：光标先飞到方框左上角，**再**把框拖到右下角；框在光标到达之前绝不出现，尖端全程钉在框的右下角。
- **吸附参考线**：拖动时从框的四边拉出洋红色细线，一直延伸到屏幕外 —— 就是 Figma 的 smart guides。

时间轴上每个"会改变画面"的步骤前面都排了一个 `aim` 步骤（只移动光标、不改变任何东西），两者间隔严格等于 `travel`。所以**画面上不会出现"内容先到、光标后到"**：这条在测试里是硬断言（不仅比时间，还比光标坐标）。

## 四类内容手势

布局阶段所有块都一样（拖出灰色占位框），**内容阶段按块的类型换手势**——这也正是设计师的真实动作：文字是打字，按钮和卡片是从左上角把形状拉出来，列表行是复制上一行再拖到位置。

| 类型 | 自动判定 | 手势 | 时长 |
|---|---|---|---|
| `text` | 子元素只有行内标签（`span/em/strong/b/i/a/small/code`…）或没有子元素 | 光标停在文字右端当插入符，文字从左往右**逐格打出来**（`clip-path` 展开） | 40ms/字，夹在 240–1100ms |
| `button` | `button` / `summary` / `role=button` / 带 `href` 的 `a` | 从**左上角**整块拉出来：宽高同时生长（形状先出，文字跟着露出） | 340ms |
| `item` | `li` / `tr` / `dd` / `dt` | **复制拖动**：克隆一份从上一行的位置平移进来，落位后本体替换副本 | 460ms |
| `box` | 其余容器（卡片、表头、列表容器…） | 和按钮同一套：从**左上角**拉出来 | 320ms |

覆盖判定：`<div data-swarm-draw="item">` 可选 `text | button | item | box`。

四类手势的时长会写进时间轴，所以下一块的内容一定等上一块"打完/拉完/拖完"才开始；配合前置的 `aim` 步，光标永远先到位、再动手。

## 并行：谁在画哪里

- `maxConcurrent`（默认 6）决定同时有几个区域在被画；每个区域由**一只**光标从拉框干到上色，不中途换手。
- 派活是**随机**的：谁空闲谁接，不会总让前几只光标霸占任务；一轮下来 18 只里通常有 7~9 只都干过活。
- 没活干的光标不会傻站着：它们**飞到"正在被画"的那个区域里的块上，套一个测量框（描边 + 尺寸徽标），停 0.5~1s 再换下一个** —— 参考片里"满屏都在动、到处是测量框"的观感就是这么来的。目标只从**正在绘制中**的区域里挑，所以每个测量框旁边都有真实进展。
- 开始时也有入场：18 只光标从屏幕下方飞进来，约 0.7s 后才开始画第一块（不会一上来就动工）。
- 一**幕**画完就收工：悬停框撤掉 → 礼花炸开 → 光标节点移除，屏幕回到干净页面 + HUD。不会出现"画完了还在乱点"。
- **没有任务时同样离场**：视口里没有待画区域（都画完了、或者压根不在视口），即便什么都没画过，光标也会放礼花走人，不留一屏干等的箭头。
- 滚动让新的区域进入视口 → 18 只光标从**屏幕外**飞回来（下滚从底部、上滚从顶部），开下一幕。入场用 boids 式转向：寻位（带减速的 arrive）+ 互相分离 + 轻微游走，所以是一群鸟散开的曲线，不是并排直线。
- 光标**机头始终朝向飞行方向**：按速度方向求航向，绕机头（transform-origin 在机头）平滑转向、角度归一到 ±180°，游走抖动不会让它乱转。
- 等新内容时 `requestAnimationFrame` 是停的，只由 `scroll` / `resize` 唤醒，空转开销为零。

## 安装

```bash
npm i swarm-draw
```

```js
import { createSwarm } from 'swarm-draw';        // 原生
import { SwarmDraw } from 'swarm-draw/react';    // React
import { SwarmDraw } from 'swarm-draw/vue';      // Vue 3
```

零运行时依赖；`react` / `vue` 是可选 peer 依赖，用不到就不装。

## 用法

**默认自动识别，不需要任何标记**：

```js
import { createSwarm } from 'swarm-draw';

createSwarm({ agents: 18, maxConcurrent: 6 }).start();
```

**想精确控制时再加标记**（页面上只要存在任意 `data-swarm-layer`，自动识别就让位给标记）：

```html
<div data-swarm-layer>                     <!-- 一个会被"画"出来的区域（一个 artboard） -->
  <h3 data-swarm-part>待办事项</h3>          <!-- 结构块，按 DOM 顺序逐个画 -->
  <div class="kpis">
    <div class="kpi" data-swarm-part>…</div>  <!-- 嵌套的块也按 DOM 顺序，天然由外向内 -->
  </div>
</div>
```

标记约定：

- `data-swarm-layer` = 一个 artboard；其中所有 `data-swarm-part` = 结构块，按 **DOM 前序遍历**（父先于子、左上到右下）逐个拖出来。库里不做排序，你的 HTML 顺序就是设计师的工作顺序。
- 没有 part 的 layer，整个 layer 当一个 part。
- **嵌套 layer 不算第二个 artboard**：只有最外层被当成画板，内层的 part 归外层，按文档顺序一起画。
- **看不见的不参与**：`start()` 时尺寸为 0 的区域（`display:none` 的标签页等）直接不纳入本轮，不会把进度卡住。
- `start()` 会对 DOM 做一次快照：之后异步渲染出来的节点不会被自动接管，需要 `stop()` + `start()` 重扫。
- layer 自己的文字必须包在元素里。绘制期间靠 `visibility` 控制显隐，裸露的文本节点藏不住；不属于任何 part 的内容随容器一起出现，不参与逐块绘制。
- 判定完全靠这两个属性，没有任何自动推断；没标属性的元素库不会碰。

## 自动识别规则

不加任何属性时，`start()` 会扫一遍 DOM：

- **画板（layer）**：有可绘制外观（背景色 / 边框 / 阴影之一）、宽 ≥ 120、高 ≥ 44、面积 ≤ 视口 50%、不是 `fixed/sticky`、内部有可见子元素。从 `root`（默认 `body`）往下找，**命中即不再深入**，所以嵌套卡片会变成外层的结构块而不是第二个画板。
- **结构块（part）**：画板内**最内层**的可见块（≥ 10×10）—— 标题、行、卡片、按钮、图表。满足任一条件是"原子块"，不再往里拆：① `li/tr/button/img/svg/video/input…`；② **自己画了盒子**（背景色 / 渐变 / 边框 / 阴影之一，比如带边框的卡片或胶囊）；③ 子元素都是行内标签（`span/em/b/small…`）或没有子元素。
- 什么都没识别到（整页都是无背景的平铺 section）时，会**回退**：挑面积 ≥ 260×120、内部至少有两个可见块的最大 section 当画板。
- 想整体排除某块区域：给它加 `data-swarm-ignore`（子树都不参与识别）。
- 想看清楚识别结果：`createSwarm({ debug: true })` 会给画板/块加虚线描边（蓝＝画板、洋红＝块），并把 `data-swarm-role="layer|part"` 写在元素上。
- **跳过**：`nav, header, footer, aside, script, style, template, iframe, [role=navigation], [aria-hidden="true"], [hidden]`（可用 `skip` 覆盖）。
- 上限：`maxLayers` 40 个画板、`maxParts` 24 个块/画板。

识别结果可以在 `swarm.state.total` 里看到；`demo/auto.html` 是完全无标记的同一套页面。

## 配置

| 选项 | 默认 | 说明 |
|---|---|---|
| `auto` | `true` | 页面上没有标记时自动识别画板与块 |
| `root` | 未指定 → `body` | 指定选择器或元素后，**只在这个根里找**；根自身也算候选画板（比如 `root: '#app'` 或 `root: 'main'`） |
| `skip` | 见上文 | 自动识别要跳过的选择器 |
| `minWidth` / `minHeight` | `120` / `44` | 画板最小尺寸 |
| `maxAreaRatio` | `0.5` | 画板最大面积占视口比例（挡掉整页容器） |
| `maxParts` / `maxLayers` | `24` / `40` | 自动识别上限 |
| `debug` | `false` | 虚线标出识别出的画板与块（蓝/洋红） |
| `layerSelector` / `partSelector` | `[data-swarm-layer]` / `[data-swarm-part]` | 标记模式的选择器 |
| `agents` | `18` | 光标数量 = HUD 上的 agents 数 |
| `colors` | 10 色调色板 | 光标 / 描边 / 遮罩 / 礼花配色 |
| `maxConcurrent` | `6` | 同时"正在画"的画板数上限 |
| `speed` | `1` | 全局速度倍率，运行中可改 |
| `hud` | `true` | 是否显示底部 HUD |
| `tour` | `false` | 启动即自动滚动（Touring 模式） |
| `document` | `document` | 目标文档，便于 iframe / 测试 |
| `onDone` | — | 全部画完的回调 `({ built, total })` |

## API

| 方法 | 说明 |
|---|---|
| `swarm.start()` | 注入样式、给所有 layer 盖空态、生成光标与 HUD、开始绘制；幂等 |
| `swarm.stop()` | 停帧并清掉所有类名 / 浮层 / 样式，页面完全复原；可再次 `start()` |
| `swarm.tour(on = true)` | 开关 Touring：自动滚到下一个待绘制的 layer |
| `swarm.setSpeed(n)` | 速度倍率（HUD 的 `1x` 在 `1 → 2 → 0.5` 循环） |
| `swarm.on(event, fn)` | 监听 `'done'`；返回取消订阅函数 |
| `swarm.state` | `{ built, total, active, agents, running, touring, speed }` |

行为约定：

- 只有进入视口的 layer 才开始画；有等待中的 layer 在屏幕外且不在 Touring 时，HUD 显示 `scroll to keep building`。
- 手动态：你滚到哪画到哪。Touring 态：库自己滚。
- HUD 的 `✕` 等于 `stop()`。
- 按"幕"工作：当前视口画完 → 礼花离场 → 光标 DOM 清空、rAF 停掉、HUD 提示 `scroll to keep building`；滚动进来新区域 → 光标飞回、继续画。

## React / Vue 封装

```jsx
// React
import { SwarmDraw } from 'swarm-draw/react';

const ref = useRef();
<SwarmDraw ref={ref} agents={18} maxConcurrent={6}>
  <section className="card">…</section>
</SwarmDraw>;
// ref.current → { start, stop, tour, setSpeed, state }
```

```vue
<!-- Vue 3 -->
<script setup>
import { SwarmDraw } from 'swarm-draw/vue';
const swarm = ref();
</script>

<template>
  <SwarmDraw ref="swarm" :options="{ agents: 18, maxConcurrent: 6 }">
    <section class="card">…</section>
  </SwarmDraw>
</template>
```

- 组件自己渲染的那个 `<div>` 就是识别根：**只画你放进去的东西**，页面其它区域不受影响。
- 卸载时自动 `stop()`；选项变了自动重启（React 用可序列化选项的签名，Vue 用 `deep watch`）。
- SSR 安全：`start()` 只在挂载后执行，服务端只渲染一个空壳。
- `react` / `vue` 都是**可选 peer 依赖**，用不到就不装。

## 时间轴

由 `src/plan.js` 的 `buildPlan(partCount)` 生成，单位 ms，**未乘速度倍率**（运行时按 `elapsed * speed` 比较，速度可随时改）：

| 步骤 | 耗时 | 设计师在干嘛 |
|---|---|---|
| `mark` | 520 | 飞到区域左上角（此时区域还是空白） |
| `frame` | 700 | 拖出 artboard 框 + 参考线 |
| `release` | 220 | 松手：容器出现、去饱和 |
| `aim` + `wire` × n | 每块 = 160 飞过去 + 240 拖开（块间隔 70） | 由外向内切结构，灰块 + 文字条 |
| `hold` | 300 | 布局定稿，停一下 |
| `aim` + `fill` × n | 每块 = 160 飞过去 + 该块的手势时长（块间隔 70） | 灰色文字条 → 打字 / 拉出 / 复制拖动 / 直接出现 |
| `polish` | 460 | 上色：`saturate(0)` → 1 |
| `settle` | 240 | 撤走控制点与徽标 |

1 个块 ≈ 3.2s、2 个块 ≈ 4.1s、3 个块 ≈ 5.0s。觉得快慢不对就调 `speed`（`0.5x` 再慢一倍）。

## 状态类名

写页面 CSS 时不要覆盖这几个类，它们由库在运行时增删：

| 类名 | 挂在哪 | 含义 |
|---|---|---|
| `sw-veiled` | layer | 还没被画：占位保留、像素不画 |
| `sw-laying` | layer | 容器已成立，所有 part 仍隐藏 |
| `sw-wireframe` | layer | 线框态：`filter: saturate(0)` |
| `sw-polishing` | layer | 上色过渡中（460ms 后自然结束） |
| `sw-wire` | part | 灰色结构块（子节点隐藏） |
| `sw-wire-text` | part | 结构块里有文案 → 显示灰色文字条 |
| `sw-part` | 块 | 库给每个块加的样式钩子（标记模式和自动模式一致） |
| `sw-filled` | part | 该块内容已写进去 |
| `sw-typing` | part | 正在打字 / 正在拉出（配合 `--sw-reveal: 0→1`） |
| `sw-mask` | 浮层 | 被拖方框内的半透明填充（拖动中 12%，松手淡出） |
| `sw-spark` / `sw-ring` | 浮层 | 收尾礼花的火花与光环，烧完自动移除 |
| `sw-ghost` | 浮层 | 复制拖动时的那份克隆 |
| `is-framing` / `is-drawn` | 浮层 | 测量框正处于拖拽态 / 已落定 |
| `is-on` | 浮层参考线 | smart guides 可见 |

## 性能

- 除正在被拖的那一个方框，动画只写 `transform` / `opacity` / `background-color` / `visibility`，不改尺寸。
- 空态和线框态都用 `visibility:hidden` 而不是 `display:none`，布局全程锁定，页面零重排。
- 每帧最多 `maxConcurrent` 次 `getBoundingClientRect()`，测量值没变化就不写 DOM。
- 参考线用百分比定位挂在被拖方框上，不需要每帧计算屏幕坐标。
- **坐标不缓存**：描边框、尺寸徽标、参考线、幽灵副本都按当前帧的 `getBoundingClientRect()` 摆放；滚动时另有 `syncScroll()` 同步平移光标位置与运动向量。手滚、Touring 自动滚都不会出现"框和光标落后于页面"。
- 顺序是"先滚动、再绘制"：否则 chrome 会落后一帧（自动滚动时正好是 16px）。
- 视口扫描每 8 帧一次；光标走二次贝塞尔（工作手势）或 boids 转向（入场），落位后 ±1.5px 呼吸抖动（抖动不参与朝向计算）。
- 悬停测量框每个 agent 只保留 1 个 DOM 节点并复用，逐帧跟随（滚动时才需要重排，平时尺寸不变）。

## 发布与部署

三个 GitHub Actions 工作流，都在 `.github/workflows/`：

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | push main / PR | Node 22 + 24 上 `npm ci` → `npm test` → 构建 demo 站点并上传 artifact |
| `publish.yml` | push `v*` tag 或手动 | 跑测试 → 校验元数据与 tag/版本一致 → `npm publish --access public` |
| `pages.yml` | push main 或手动 | 跑测试 → `npm run build:site` → 部署 GitHub Pages |

**发布走 npm 的 Trusted Publishing（OIDC），仓库里不存任何 token**：

- npm 包页面 → Settings → Trusted Publisher 里填 `yunhai-dev/swarm-draw` + **workflow 文件名 `publish.yml`**（必须与 `.github/workflows/` 里的文件名完全一致）。
- 工作流只需要 `permissions: id-token: write`，`npm publish` 会用 OIDC 换一次性凭据，并自动带上 provenance 签名。
- trusted publishing 要求 npm CLI ≥ 11.5.1，所以工作流里固定 `node 24` + `npm install -g npm@latest`。
- 首次配置后要**成功发布一次**才算验证；之后 npm 页面会显示 Provenance 标记。

发版流程：

```bash
npm version patch            # 改版本 + 提交 + 打 tag
git push --follow-tags       # 推送后 publish.yml 自动发布
```

Pages 需要在仓库 **Settings → Pages → Source** 选 **GitHub Actions**，之后每次推 main 都会更新
`https://yunhai-dev.github.io/swarm-draw/`（首页是 demo 索引，另有 `/demo/index.html` 与 `/demo/auto.html`）。

## 本地运行

```bash
npm install          # 只装 jsdom，用于测试
npm test             # 42 个用例（含自动识别的样式/原子块/忽略/回退/调试、左上角拉出、入场节拍、无任务离场、鸟群入场与朝向、礼花收尾、滚动不偏移、手势分型、打字进度、复制拖动、拖框遮罩、并行、光标先到、空闲即静止）
npx serve .          # /demo/index.html（带标记）· /demo/auto.html（零标记，自动识别）
npm run build:site   # 生成 _site/（Pages 用的静态站点）
```

用例覆盖：自动识别（root 作用域与根自身、画板/块推断、跳过整页容器与地标、标记优先、空页面） / 时间轴顺序与 aim→act 间隔 / CSS 显隐门控（`sw-wire` 只显灰块、`sw-filled` 真显影、`sw-wire-text` 文字条、`sw-wireframe` 去饱和）/ 拖框增长与光标钉角 / 参考线出现与消失 / 空→框→容器→布局→文案→上色 顺序 / 光标先到内容后到（比坐标不比时间）/ 四种内容手势（打字进度与插入符位置、卡片/按钮左上角拉出、克隆落位、类型推断）/ 滚动中的框与光标跟随（拖拽中滚、冻结时滚）/ 入场节拍（先飞入再动工）/ 无任务离场（飞入→礼花→滚回）/ 鸟群入场（屏幕外起飞、路径曲率、机头跟随飞行方向）/ 收尾礼花（火花与光环生成→烧尽、光标移除、HUD 保留）/ 多光标并行与悬停测量 / 一幕结束即离场并在滚动后飞回 / 嵌套层与不可见区域的取舍 / 并发上限 / 滚动门槛 + Touring / 速度倍率 / `stop()` 复原。

## 已知限制

- `sw-wireframe` 用 `filter` 实现去饱和，容器内如果有 `position:fixed` 的后代会被改定位参照系（卡片类布局无影响）。
- 不处理 `prefers-reduced-motion`。
- 光标不做朝向旋转（纸飞机始终朝右上），方框靠改容器尺寸实现 1:1 跟随，不是 `stroke-dashoffset` 描边动画。
- 范围到"画完"为止：不做返工/撤销，也不做画布缩放平移。
