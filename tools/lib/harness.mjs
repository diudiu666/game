/**
 * 浏览器验收脚本的公共入口。
 *
 * 原来这十几个脚本各自写死了一条 Windows 专用路径：
 *   %LOCALAPPDATA%\ms-playwright\chromium-1228\chrome-win64\chrome.exe
 * 换台机器、换个 playwright 版本、或者在 macOS / Linux 上跑，全部会挂，
 * 而且报错信息是「文件不存在」，看不出是浏览器没装。
 *
 * 现在统一按这个顺序找 Chromium：
 *   1. 环境变量 CHROME_PATH（想用系统浏览器就设这个）
 *   2. playwright-core 自己解析出的路径
 *   3. 本机 playwright 浏览器缓存目录里版本号最大的那个 chromium
 *   4. 系统安装的 Chrome / Chromium / Edge
 * 全都找不到才抛错，并说明该装什么。
 *
 * 用法：
 *   import { launch, sleep } from './lib/harness.mjs';
 *   const browser = await launch();
 *
 * 换浏览器：
 *   CHROME_PATH=/usr/bin/chromium node tools/pickcheck.mjs
 */
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * 无头环境跑 WebGL 需要软件光栅化。
 * headless 模式默认没有 GPU，这三条让 SwiftShader 顶上，
 * 否则 three.js 初始化直接抛「无法创建 WebGL 上下文」。
 */
const WEBGL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 单个 chromium-<rev> 目录下，各平台的可执行文件位置 */
function layoutOf(dir) {
  return [
    join(dir, 'chrome-win64', 'chrome.exe'),
    join(dir, 'chrome-win', 'chrome.exe'),
    join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    join(dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    join(dir, 'chrome-linux', 'chrome'),
    join(dir, 'chrome-linux64', 'chrome'),
    join(dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    join(dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
    join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
  ];
}

/** playwright 的浏览器缓存根目录（每个平台不一样） */
function browserRoots() {
  const custom = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== '0') return [custom];
  switch (platform()) {
    case 'win32':
      return [join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ms-playwright')];
    case 'darwin':
      return [join(homedir(), 'Library', 'Caches', 'ms-playwright')];
    default:
      return [join(homedir(), '.cache', 'ms-playwright')];
  }
}

/** 缓存目录里所有 chromium-* 的可执行文件，版本号大的排前面 */
function fromCache() {
  const out = [];
  for (const root of browserRoots()) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue; // 这个平台没装过 playwright 浏览器
    }
    const rev = (name) => Number(name.split('-').pop()) || 0;
    entries
      .filter((name) => /^chromium(_headless_shell)?-\d+$/.test(name))
      .sort((a, b) => rev(b) - rev(a))
      .forEach((name) => out.push(...layoutOf(join(root, name))));
  }
  return out;
}

/** 系统装好的浏览器 */
function fromSystem() {
  switch (platform()) {
    case 'win32':
      return [
        join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
        join(process.env.PROGRAMFILES || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
        join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      ];
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ];
    default:
      return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
      ];
  }
}

/**
 * 找到可用的 Chromium 可执行文件。
 * @returns {string} 绝对路径
 */
export function findChromium() {
  const explicit = process.env.CHROME_PATH;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`CHROME_PATH 指向的浏览器不存在：${explicit}`);
    }
    return explicit;
  }

  // playwright 自己认为该用哪个（版本对得上时最省事）
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    // 老版本 playwright-core 可能没有这个方法，继续往下找
  }

  const found = [...fromCache(), ...fromSystem()].find((p) => p && existsSync(p));
  if (found) return found;

  throw new Error(
    [
      '找不到 Chromium，浏览器类验收脚本跑不起来。三种解决办法，任选其一：',
      '',
      '  1. 装一份给 playwright 用的浏览器（推荐）：',
      '       npx playwright-core install chromium',
      '     或按你本机 playwright 版本：',
      '       npx playwright install chromium',
      '',
      '  2. 用系统已经装好的 Chrome：',
      '       CHROME_PATH=/path/to/chrome  （Windows 例：CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"）',
      '',
      '  3. 只跑不需要浏览器的测试（规则 / 协议 / 连通性）：',
      '       npm run test:rules',
    ].join('\n'),
  );
}

/**
 * 起一个浏览器，参数已经按「无头 + 软件 WebGL」配好。
 * @param {object} [opts] 透传给 chromium.launch，args 会和默认参数合并去重
 */
export async function launch(opts = {}) {
  const { args = [], ...rest } = opts;
  return chromium.launch({
    ...rest,
    executablePath: rest.executablePath || findChromium(),
    args: [...new Set([...WEBGL_ARGS, ...args])],
  });
}
