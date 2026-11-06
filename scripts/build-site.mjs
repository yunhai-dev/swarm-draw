import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, '_site');

const LANDING = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>swarm-draw · demo</title>
<style>
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #f2f3f5; color: #1b1d21;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif;
  }
  main { width: min(680px, calc(100vw - 48px)); padding: 40px 0; }
  h1 { font-size: 30px; letter-spacing: -.5px; margin: 0 0 8px; }
  p.lead { color: #5b6169; margin: 0 0 28px; }
  .cards { display: grid; gap: 12px; }
  a.card {
    display: block; padding: 18px 20px; border-radius: 12px; text-decoration: none;
    background: #fff; border: 1px solid #e8eaee; color: inherit; transition: .15s ease;
  }
  a.card:hover { border-color: #1a8cff; transform: translateY(-1px); box-shadow: 0 10px 24px rgba(26,140,255,.12); }
  a.card b { display: block; font-size: 15px; margin-bottom: 4px; }
  a.card span { color: #6b727b; font-size: 13px; }
  code { background: #eef1f5; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  footer { margin-top: 26px; color: #8b909a; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>swarm-draw</h1>
  <p class="lead">一群纸飞机光标把页面「按设计师的顺序」画出来：拉框 → 切结构 → 打字 → 上色 → 礼花收场。</p>
  <div class="cards">
    <a class="card" href="./demo/index.html">
      <b>带标记的 demo</b>
      <span>用 <code>data-swarm-layer</code> / <code>data-swarm-part</code> 精确控制画板与块</span>
    </a>
    <a class="card" href="./demo/auto.html">
      <b>零标记 demo（自动识别）</b>
      <span>同一套页面，画板与块全部由库自己识别</span>
    </a>
  </div>
  <footer>按「幕」工作：当前屏幕画完会放礼花离场，向下滚动再飞回来画下一屏。</footer>
</main>
</body>
</html>
`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, 'src'), join(out, 'src'), { recursive: true });
await cp(join(root, 'demo'), join(out, 'demo'), { recursive: true });
await writeFile(join(out, 'index.html'), LANDING);
await writeFile(join(out, '.nojekyll'), '');
console.log('site built -> _site/');
