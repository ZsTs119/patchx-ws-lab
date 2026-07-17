import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WS_LAB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_ROOT = path.join(WS_LAB_ROOT, "src");

async function read(relativePath) {
  return readFile(path.join(WS_LAB_ROOT, relativePath), "utf8");
}

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJavaScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

function releaseVersionFromIndex(indexHtml) {
  const match = indexHtml.match(/\.\/src\/app\.js\?v=([a-z0-9-]+)/i);
  assert.ok(match, "index.html 必须为 app.js 声明发布版本");
  return match[1];
}

test("一方静态资源和 ES Module 使用同一个发布版本", async () => {
  const indexHtml = await read("index.html");
  const releaseVersion = releaseVersionFromIndex(indexHtml);
  assert.match(releaseVersion, /^\d{8}-[a-z0-9-]+$/);

  const entryAssetPattern = /(?:href|src)="(\.\/(?:src|styles)\/[^"#]+)"/g;
  const entryAssets = [...indexHtml.matchAll(entryAssetPattern)].map((match) => match[1]);
  assert.ok(entryAssets.length >= 4, "应至少覆盖 app.js 和三个样式文件");
  for (const asset of entryAssets) {
    const url = new URL(asset, "https://ws-lab.invalid/");
    assert.equal(url.searchParams.get("v"), releaseVersion, `${asset} 发布版本不一致`);
  }

  const importPattern = /(?:\bfrom\s+|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+\.js(?:\?[^"']*)?)["']/g;
  const sourceFiles = await collectJavaScriptFiles(SRC_ROOT);
  let importCount = 0;
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    for (const match of source.matchAll(importPattern)) {
      importCount += 1;
      const specifier = match[1];
      const url = new URL(specifier, "https://ws-lab.invalid/src/current.js");
      assert.equal(
        url.searchParams.get("v"),
        releaseVersion,
        `${path.relative(WS_LAB_ROOT, sourceFile)} -> ${specifier} 发布版本不一致`
      );
    }
  }
  assert.ok(importCount > 0, "至少应检查一个本地 ES Module 导入");
});

test("模块清单继承 module-host 的发布版本并禁用直接缓存命中", async () => {
  const indexHtml = await read("index.html");
  const releaseVersion = releaseVersionFromIndex(indexHtml);
  const moduleUrl = new URL("../src/core/module-host.js", import.meta.url);
  moduleUrl.searchParams.set("v", releaseVersion);

  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.window = { location: { href: "https://ws-lab.invalid/" } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => ({ modules: [] }) };
  };

  try {
    const { ModuleHost } = await import(moduleUrl.href);
    const host = new ModuleHost({ store: { add() {} } });
    await host.load();
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  const requestUrl = new URL(requests[0].url);
  assert.equal(requestUrl.pathname, "/modules/registry.json");
  assert.equal(requestUrl.searchParams.get("v"), releaseVersion);
  assert.equal(requests[0].options?.cache, "no-cache");
});

test("中英文部署说明包含首页和一方资源缓存重校验配置", async () => {
  for (const readme of ["README.md", "README.en.md"]) {
    const content = await read(readme);
    assert.match(content, /location = \/index\.html/);
    assert.match(content, /Cache-Control "no-cache, no-store, must-revalidate"/);
    assert.match(content, /location ~\* \^\/\(\?:src\|styles\|modules\)/);
    assert.match(content, /Cache-Control "no-cache, must-revalidate"/);
  }
});
