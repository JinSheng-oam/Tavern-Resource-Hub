import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePngCharacterCard, MINIMAL_1X1_PNG } from '../card-codec.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const previewHostRoot = process.env.ST_PUBLIC_DIR || path.resolve(root, '../Tavern-API-Desk/.preview/host');
const captureDir = process.env.TRH_CAPTURE_DIR || '';

async function readOptionalAsset(filePath, fallback = '') {
    try {
        return await readFile(filePath);
    } catch {
        return fallback;
    }
}

const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
].filter(Boolean);

let browserPath = null;
for (const candidate of candidates) {
    try {
        await access(candidate);
        browserPath = candidate;
        break;
    } catch {
        // Try next
    }
}
assert.ok(browserPath, '未找到 Chromium / Chrome / Edge 浏览器可执行文件');

// 生成两张不同色调的 SVG 头像用于模拟角色立绘
function createPortraitSvg(title, subtitle, bg1, bg2, accent) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
        <defs>
            <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="${bg1}"/>
                <stop offset="100%" stop-color="${bg2}"/>
            </linearGradient>
        </defs>
        <rect width="400" height="300" fill="url(#g)"/>
        <circle cx="310" cy="70" r="95" fill="${accent}" fill-opacity="0.14"/>
        <circle cx="200" cy="118" r="44" fill="${accent}" fill-opacity="0.28" stroke="${accent}" stroke-width="2"/>
        <path d="M126 248 C126 192 274 192 274 248" fill="${accent}" fill-opacity="0.22" stroke="${accent}" stroke-width="2"/>
        <text x="24" y="254" fill="#ECF0F6" font-family="sans-serif" font-size="22" font-weight="bold">${title}</text>
        <text x="24" y="278" fill="#8C96AD" font-family="monospace" font-size="13">${subtitle}</text>
    </svg>`;
}

const remoteUpdatedAlicePng = encodePngCharacterCard(MINIMAL_1X1_PNG, {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
        name: '星野梦 (Hoshino Yume)',
        description: '旧书店「星轨堂」的守夜人，第二章新增了夜间星象观测室剧情与动态好感度事件。',
        personality: '沉静、博学、微毒舌',
        scenario: '雨夜的旧书店与天文台',
        first_mes: '欢迎回到星轨堂，二楼的星象仪已经为你校准好了。',
        character_version: '2.4.0',
        creator: 'AtelierWorks',
        alternate_greetings: ['今晚的猎户座格外清晰，要一起看吗？', '你借走的那本古籍，读到第三章了吗？'],
        tags: ['奇幻', '日常', '书店', '天文'],
        character_book: {
            name: '星轨堂设定集',
            entries: [
                { id: 1, keys: ['星轨堂', '书店'], comment: '核心据点', content: '位于旧城区尽头的三层古董书店。', enabled: true },
                { id: 2, keys: ['星象仪'], comment: '二楼机关', content: '能够推演过去百年星图的黄铜机械。', enabled: true },
                { id: 3, keys: ['守夜怀表'], comment: '新增道具', content: 'v2.4 新增：可回溯一小时记忆的银怀表。', enabled: true },
            ],
        },
        extensions: {
            world: '星轨堂设定集',
            fav: true,
            regex_scripts: [
                { id: 'rx1', scriptName: '状态栏折叠渲染' },
                { id: 'rx2', scriptName: '星象仪特效替换' },
            ],
            tavern_helper: {
                scripts: [
                    { id: 'th1', name: '星轨堂好感度面板 v2.4' },
                    { id: 'th2', name: '背景音乐联动控制器' },
                ],
                variables: { affection: 0, chapter: 1 },
            },
        },
    },
});

const moduleFiles = new Set([
    'index.js',
    'ui-workspace.js',
    'data-editor.js',
    'update-engine.js',
    'platform.js',
    'url-resolver.js',
    'card-codec.js',
    'binding-store.js',
]);

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');

        if (url.pathname === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tavern Resource Hub Browser E2E</title>
    <link rel="stylesheet" href="/fontawesome.css">
    <link rel="stylesheet" href="/solid.css">
    <link rel="stylesheet" href="/style.css">
    <style>
        body { margin: 0; padding: 20px; background: #141720; color: #ECF0F6; font-family: sans-serif; }
        #extensionsMenu { display: none; }
    </style>
</head>
<body>
    <div id="extensions_settings2"></div>
    <div id="extensionsMenu"></div>
    <script>
        window.__TAURITAVERN__ = true;
        window.TavernHelper = {
            getTavernHelperVersion: () => '3.4.2',
        };
        const mockContext = {
            characterId: 0,
            extensionSettings: {
                tavernResourceHub: {
                    schemaVersion: 1,
                    githubMirrorPrefix: '',
                    bindings: {
                        character: {
                            'HoshinoYume.png': {
                                sourceUrl: location.origin + '/remote/HoshinoYume_v2.4.png',
                                lastHash: 'old_hash_123456',
                                lastVersion: '1.8.0',
                                remoteVersion: '2.4.0',
                                lastUpdatedAt: Date.now() - 86400000 * 3,
                                hasUpdate: true,
                                linkedPreset: '破限叙事文风 Pro',
                            },
                            'Valkyrie.png': {
                                sourceUrl: 'https://raw.githubusercontent.com/atelier/cards/main/Valkyrie.png',
                                lastHash: 'ab91c082f4e1',
                                lastVersion: '1.2.0',
                                lastUpdatedAt: Date.now() - 3600000 * 5,
                                hasUpdate: false,
                                linkedPreset: '破限叙事文风 Pro',
                            }
                        },
                        preset: {
                            '破限叙事文风 Pro': {
                                sourceUrl: 'https://raw.githubusercontent.com/atelier/presets/main/NarrativePro.json',
                                lastHash: 'ef891023a1b2',
                                lastVersion: '3.1',
                                lastUpdatedAt: Date.now() - 3600000 * 12,
                                hasUpdate: false,
                            }
                        },
                        worldbook: {
                            '星轨堂设定集': {
                                sourceUrl: 'https://raw.githubusercontent.com/atelier/lore/main/StarlightShop.json',
                                lastHash: 'cc0011223344',
                                lastUpdatedAt: Date.now() - 86400000,
                                hasUpdate: false,
                            }
                        }
                    }
                }
            },
            chatCompletionSettings: {
                preset_settings_openai: '破限叙事文风 Pro',
                chat_completion_source: 'custom',
                custom_url: 'https://api.my-private-gateway.example/v1',
                custom_model: 'claude-3-7-sonnet-20250219',
            },
            characters: [
                {
                    name: '星野梦 (Hoshino Yume)',
                    avatar: 'HoshinoYume.png',
                    chat: 'HoshinoYume - 2026-11-18-主线存档',
                    fav: true,
                    description: '旧书店「星轨堂」的守夜人 v1.8 旧版描述。',
                    personality: '沉静、博学',
                    scenario: '雨夜的旧书店',
                    first_mes: '欢迎来到星轨堂，要喝杯热红茶吗？',
                    tags: ['奇幻', '日常', '书店'],
                    data: {
                        name: '星野梦 (Hoshino Yume)',
                        description: '旧书店「星轨堂」的守夜人 v1.8 旧版描述。',
                        character_version: '1.8.0',
                        creator: 'AtelierWorks',
                        alternate_greetings: ['雨下大了呢。'],
                        character_book: {
                            name: '星轨堂设定集',
                            entries: [
                                { id: 1, keys: ['星轨堂'], comment: '核心据点', content: '旧城区尽头的书店。', enabled: true },
                            ],
                        },
                        extensions: {
                            world: '星轨堂设定集',
                            fav: true,
                            regex_scripts: [{ id: 'rx1', scriptName: '状态栏折叠渲染' }],
                            tavern_helper: {
                                scripts: [{ id: 'th1', name: '星轨堂好感度面板 v1.8' }],
                                variables: { affection: 75, chapter: 2 },
                            },
                        },
                    },
                },
                {
                    name: '瓦尔基里 · 苍银骑士',
                    avatar: 'Valkyrie.png',
                    chat: 'Valkyrie - 远征篇',
                    fav: false,
                    description: '北方边境的银甲圣骑士。',
                    first_mes: '长剑只为守护誓约而挥动。',
                    tags: ['史诗', '骑士', '战斗'],
                    data: {
                        name: '瓦尔基里 · 苍银骑士',
                        character_version: '1.2.0',
                        creator: 'NordicForge',
                        alternate_greetings: ['风雪要来了。', '整理装备，明日出发。'],
                        extensions: {
                            world: '北境编年史',
                            regex_scripts: [{ id: 'rx_v1', scriptName: '战斗伤害高亮' }],
                            tavern_helper: {
                                scripts: [{ id: 'th_v1', name: '战术状态栏' }],
                                variables: { stamina: 100 },
                            },
                        },
                    },
                },
                {
                    name: '苏沐晴 · 临江仙',
                    avatar: 'SuMuqing.png',
                    chat: 'SuMuqing - 烟雨江南',
                    fav: true,
                    description: '江南药王谷传人，精通医理与古琴。',
                    first_mes: '这味药需得用梅花上的雪水煎服。',
                    tags: ['古风', '仙侠', '日常'],
                    data: {
                        name: '苏沐晴 · 临江仙',
                        character_version: '1.0.5',
                        creator: 'CloudPavilion',
                        alternate_greetings: [],
                        extensions: {
                            world: '九州风物志',
                            regex_scripts: [],
                        },
                    },
                }
            ],
            presets: {
                '破限叙事文风 Pro': {
                    version: '3.1',
                    temperature: 0.92,
                    openai_max_context: 64000,
                    openai_max_tokens: 4096,
                    chat_completion_source: 'custom',
                    custom_url: 'https://api.my-private-gateway.example/v1',
                    custom_model: 'claude-3-7-sonnet-20250219',
                    prompts: [
                        { identifier: 'main', name: '核心叙事指令', role: 'system', content: '保持电影级镜头感。', enabled: true },
                        { identifier: 'cot', name: '深度思维链 (CoT)', role: 'system', content: '先推演动机再输出。', enabled: true },
                        { identifier: 'anti_cliche', name: '去模板化词汇约束', role: 'system', content: '避免陈词滥调。', enabled: true },
                    ],
                    extensions: {
                        regex_scripts: [{ id: 'prx1', scriptName: '清除思维链标签' }],
                        tavern_helper: {
                            scripts: [{ id: 'pth1', name: '动态字数控制脚本' }],
                            variables: { targetWords: 800 },
                        },
                    },
                },
                '轻量日常对话 Flash': {
                    version: '1.4',
                    temperature: 0.78,
                    openai_max_context: 32000,
                    openai_max_tokens: 2048,
                    prompts: [
                        { identifier: 'main', name: '自然口语对话', role: 'system', content: '简洁自然。', enabled: true },
                    ],
                    extensions: {},
                }
            },
            worldbooks: {
                '星轨堂设定集': {
                    entries: {
                        0: { uid: 0, key: ['星轨堂'], comment: '核心据点', content: '旧城区尽头的书店。', disable: false },
                        1: { uid: 1, key: ['星象仪'], comment: '二楼机关', content: '黄铜星象仪。', disable: false },
                    },
                },
                '北境编年史': {
                    entries: {
                        0: { uid: 0, key: ['冬堡'], comment: '要塞设定', content: '抵御寒霜巨龙的北方壁垒。', disable: false },
                        1: { uid: 1, key: ['苍银骑士团'], comment: '教团编制', content: '共有十二席圣骑士。', disable: false },
                        2: { uid: 2, key: ['古战场'], comment: '隐藏区域', content: '冰封之海遗迹。', disable: true },
                    },
                },
                '九州风物志': {
                    entries: {
                        0: { uid: 0, key: ['药王谷'], comment: '门派设定', content: '隐于云梦泽深处。', disable: false },
                    },
                }
            },
            worldInfoSettings: {
                globalSelect: ['星轨堂设定集'],
            },
            getThumbnailUrl: (_, file) => '/portraits/' + encodeURIComponent(file),
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            saveSettingsDebounced: () => {},
        };
        window.SillyTavern = {
            getContext: () => mockContext,
        };
    </script>
    <script type="module">
        import { activate, dispose } from '/index.js';
        window.trhActivate = activate;
        window.trhDispose = dispose;
        activate();
        window.fixtureReady = true;
    </script>
</body>
</html>`);
            return;
        }

        if (url.pathname === '/style.css') {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.end(await readFile(path.join(root, 'style.css')));
            return;
        }

        if (url.pathname === '/fontawesome.css') {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.end(await readOptionalAsset(path.join(previewHostRoot, 'css/fontawesome.min.css'), ''));
            return;
        }

        if (url.pathname === '/solid.css') {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.end(await readOptionalAsset(path.join(previewHostRoot, 'css/solid.min.css'), ''));
            return;
        }

        if (url.pathname === '/webfonts/fa-solid-900.woff2') {
            res.setHeader('Content-Type', 'font/woff2');
            res.end(await readOptionalAsset(path.join(previewHostRoot, 'webfonts/fa-solid-900.woff2'), Buffer.alloc(0)));
            return;
        }

        const cleanModule = url.pathname.replace(/^\/+/, '');
        if (moduleFiles.has(cleanModule)) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.end(await readFile(path.join(root, cleanModule)));
            return;
        }

        if (url.pathname.startsWith('/portraits/')) {
            const name = decodeURIComponent(url.pathname.slice('/portraits/'.length));
            res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
            if (name.includes('Hoshino')) {
                res.end(createPortraitSvg('星野梦', 'STARLIGHT ATELIER', '#1B253B', '#111624', '#F5A524'));
            } else if (name.includes('Valkyrie')) {
                res.end(createPortraitSvg('瓦尔基里', 'SILVER PALADIN', '#1A2B36', '#101821', '#38D399'));
            } else {
                res.end(createPortraitSvg('苏沐晴', 'CLOUD PAVILION', '#262138', '#141220', '#94A3B8'));
            }
            return;
        }

        if (url.pathname === '/remote/HoshinoYume_v2.4.png') {
            res.setHeader('Content-Type', 'image/png');
            res.end(Buffer.from(remoteUpdatedAlicePng));
            return;
        }

        if (url.pathname.startsWith('/api/')) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        res.writeHead(404).end('Not Found');
    } catch (err) {
        res.writeHead(500).end(err.message);
    }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;
const profileDir = await mkdtemp(path.join(tmpdir(), 'tavern-resource-hub-e2e-'));

const browser = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

try {
    const wsUrl = await new Promise((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`等待 DevTools 超时: ${stderr}`)), 15000);
        browser.stderr.on('data', chunk => {
            stderr += chunk.toString();
            const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        browser.once('exit', code => {
            clearTimeout(timer);
            reject(new Error(`浏览器提前退出 (${code}): ${stderr}`));
        });
    });

    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
    });

    let nextId = 0;
    const pending = new Map();
    const exceptions = [];

    socket.onmessage = ({ data }) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.exceptionThrown') {
            exceptions.push(msg.params.exceptionDetails);
        }
        if (!pending.has(msg.id)) return;
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
    };

    function cdp(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`CDP ${method} 超时`));
            }, 20000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }

    const { browserContextId } = await cdp('Target.createBrowserContext');
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId);
    await cdp('Page.enable', {}, sessionId);

    const evaluate = async (expression) => {
        const result = await cdp('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
        }, sessionId);
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result.result.value;
    };

    const captureScreenshot = async (filename) => {
        if (!captureDir) return null;
        await mkdir(captureDir, { recursive: true });
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
        const targetPath = path.join(captureDir, filename);
        await writeFile(targetPath, Buffer.from(data, 'base64'));
        return targetPath;
    };

    await cdp('Emulation.setDeviceMetricsOverride', {
        width: 1366,
        height: 860,
        deviceScaleFactor: 1,
        mobile: false,
    }, sessionId);

    await cdp('Page.navigate', { url: origin }, sessionId);
    for (let i = 0; i < 80; i++) {
        if (await evaluate('Boolean(window.fixtureReady)')) break;
        await new Promise(r => setTimeout(r, 50));
    }

    assert.equal(exceptions.length, 0, `页面初始化异常: ${JSON.stringify(exceptions)}`);

    // 1. 验证原生抽屉入口与魔法棒菜单入口挂载成功且名称精简为“资源管理器”，抽屉宽度占满父容器
    const mounted = await evaluate(`(() => {
        const launcher = document.getElementById('tavern_resource_hub_launcher');
        const header = launcher?.querySelector('.inline-drawer-header');
        const parentWidth = launcher?.parentElement?.getBoundingClientRect().width || 0;
        const headerWidth = header?.getBoundingClientRect().width || 0;
        return {
            hasDrawer: Boolean(launcher?.querySelector('.inline-drawer')),
            drawerTitle: header?.querySelector('b')?.textContent || '',
            wandLabel: document.querySelector('#tavern_resource_hub_wand_button span')?.textContent || '',
            drawerFillsParent: parentWidth > 0 && Math.abs(parentWidth - headerWidth) <= 2,
        };
    })()`);
    assert.deepEqual(mounted, {
        hasDrawer: true,
        drawerTitle: '资源管理器',
        wandLabel: '资源管理器',
        drawerFillsParent: true,
    });

    // 2. 点击打开独立全屏管理器
    await evaluate(`document.getElementById('trh_open_workspace_btn').click(); new Promise(r => setTimeout(r, 150))`);
    const overlayVisible = await evaluate(`Boolean(document.getElementById('tavern_resource_hub_overlay'))`);
    assert.equal(overlayVisible, true);

    const charCount = await evaluate(`document.querySelectorAll('.trh-char-card').length`);
    assert.equal(charCount, 3);

    // 验证默认为浅色主题，并可切换深色主题后再切回浅色
    assert.equal(await evaluate(`document.getElementById('tavern_resource_hub_overlay').dataset.theme`), 'light');
    await captureScreenshot('trh-characters-light-desktop.png');
    await evaluate(`document.getElementById('trh_theme_toggle_btn').click(); new Promise(r => setTimeout(r, 80))`);
    assert.equal(await evaluate(`document.getElementById('tavern_resource_hub_overlay').dataset.theme`), 'dark');
    await captureScreenshot('trh-characters-dark-desktop.png');
    await evaluate(`document.getElementById('trh_theme_toggle_btn').click(); new Promise(r => setTimeout(r, 80))`);
    assert.equal(await evaluate(`document.getElementById('tavern_resource_hub_overlay').dataset.theme`), 'light');

    // 3. 在顶部链接栏输入带中文说明的链接文本并解析，验证自动提取链接与原地更新预览
    await evaluate(`(async () => {
        const input = document.getElementById('trh_global_url_input');
        input.value = '【角色卡更新】星野梦 v2.4 下载地址：' + location.origin + '/remote/HoshinoYume_v2.4.png（带内置世界书与助手脚本）';
        document.getElementById('trh_global_probe_btn').click();
        for (let i = 0; i < 50; i++) {
            if (document.getElementById('trh_confirm_staged_update_btn')) break;
            await new Promise(r => setTimeout(r, 40));
        }
    })()`);

    const stagedInfo = await evaluate(`({
        hasConfirmBtn: Boolean(document.getElementById('trh_confirm_staged_update_btn')),
        versionText: document.querySelector('.trh-diff-version-line')?.textContent || '',
        diffItemsCount: document.querySelectorAll('.trh-diff-list li').length,
    })`);
    assert.equal(stagedInfo.hasConfirmBtn, true);
    assert.ok(stagedInfo.versionText.includes('1.8.0 → 2.4.0'), `实际版本文本: ${stagedInfo.versionText}`);
    assert.ok(stagedInfo.diffItemsCount >= 4);

    await captureScreenshot('trh-update-preview-desktop.png');

    // 4. 点击“确认原地更新”，验证角色卡版本号更新为 v2.4.0、聊天会话与酒馆助手变量完整保留、内置世界书词条同步至 3 条
    await evaluate(`(async () => {
        document.getElementById('trh_confirm_staged_update_btn').click();
        for (let i = 0; i < 50; i++) {
            if (!document.getElementById('trh_confirm_staged_update_btn')) break;
            await new Promise(r => setTimeout(r, 40));
        }
    })()`);

    const afterUpdate = await evaluate(`(() => {
        const ctx = window.SillyTavern.getContext();
        const char = ctx.characters[0];
        return {
            totalCharacters: ctx.characters.length,
            version: char.data.character_version,
            chat: char.chat,
            affectionVar: char.data.extensions.tavern_helper.variables.affection,
            helperScriptCount: char.data.extensions.tavern_helper.scripts.length,
            wbEntryCount: Object.keys(ctx.worldbooks['星轨堂设定集'].entries).length,
            hasRollbackBanner: Boolean(document.querySelector('.trh-rollback-banner')),
        };
    })()`);

    assert.deepEqual(afterUpdate, {
        totalCharacters: 3,
        version: '2.4.0',
        chat: 'HoshinoYume - 2026-11-18-主线存档',
        affectionVar: 75,
        helperScriptCount: 2,
        wbEntryCount: 3,
        hasRollbackBanner: true,
    });

    // 5. 切换至移动端尺寸 (390x844) 验证双列角色卡网格、预设列表与按需底部抽屉 (Bottom Sheet)
    await cdp('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
    }, sessionId);
    await evaluate(`document.querySelector('.trh-nav-item[data-tab="character"]').click(); new Promise(r => setTimeout(r, 120))`);

    const mobileInitialState = await evaluate(`({
        inspectorDisplay: getComputedStyle(document.querySelector('.trh-inspector')).display,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    })`);
    assert.equal(mobileInitialState.inspectorDisplay, 'none', '移动端默认不遮挡主画廊列表');
    assert.equal(mobileInitialState.horizontalOverflow, false, '移动端无横向溢出');
    await captureScreenshot('trh-characters-mobile.png');

    // 点击第一张角色卡弹出底部详情抽屉
    await evaluate(`document.querySelector('.trh-char-card').click(); new Promise(r => setTimeout(r, 120))`);
    const mobileSheetOpen = await evaluate(`getComputedStyle(document.querySelector('.trh-inspector')).display`);
    assert.equal(mobileSheetOpen, 'flex', '点击角色卡后弹出移动端底部详情抽屉');
    await captureScreenshot('trh-mobile-sheet.png');

    // 点击“收起详情”关闭底部抽屉，再切换到预设选项卡
    await evaluate(`document.querySelector('.trh-mobile-sheet-close').click(); new Promise(r => setTimeout(r, 100))`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.trh-inspector')).display`), 'none');

    await evaluate(`document.querySelector('.trh-nav-item[data-tab="preset"]').click(); new Promise(r => setTimeout(r, 120))`);
    await captureScreenshot('trh-presets-mobile.png');

    // 在手机端打开预设内部编辑器，验证底部分页切换与截图布局
    await evaluate(`document.querySelector('.trh-resource-row').click(); new Promise(r => setTimeout(r, 80))`);
    await evaluate(`document.getElementById('trh_open_editor_btn').click(); new Promise(r => setTimeout(r, 120))`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true);
    assert.equal(await evaluate(`document.querySelectorAll('.trh-editor-tab-btn').length`), 4);
    await captureScreenshot('trh-editor-mobile-list.png');
    await evaluate(`document.querySelector('.trh-editor-tab-btn[data-page="item"]').click(); new Promise(r => setTimeout(r, 100))`);
    await captureScreenshot('trh-editor-mobile.png');
    await evaluate(`document.querySelector('#trh_data_editor_modal .trh-editor-header .trh-btn-icon').click(); new Promise(r => setTimeout(r, 80))`);
    await evaluate(`document.querySelector('.trh-mobile-sheet-close')?.click(); new Promise(r => setTimeout(r, 80))`);

    // 6. 验证内部数据查看与编辑功能（修改角色卡描述并保存）
    await cdp('Emulation.setDeviceMetricsOverride', {
        width: 1366,
        height: 860,
        deviceScaleFactor: 1,
        mobile: false,
    }, sessionId);
    await evaluate(`document.querySelector('.trh-nav-item[data-tab="character"]').click(); new Promise(r => setTimeout(r, 100))`);
    await evaluate(`document.querySelector('.trh-char-card[data-id="SuMuqing.png"]').click(); new Promise(r => setTimeout(r, 80))`);
    await evaluate(`document.getElementById('trh_open_editor_btn').click(); new Promise(r => setTimeout(r, 100))`);
    assert.equal(await evaluate(`Boolean(document.getElementById('trh_data_editor_modal'))`), true);
    await evaluate(`(() => {
        const ta = document.querySelector('#trh_data_editor_modal textarea');
        ta.value = '江南药王谷传人，已通过内部编辑器更新描述。';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await evaluate(`(async () => {
        document.getElementById('trh_editor_save_btn').click();
        for (let i = 0; i < 40; i++) {
            if (!document.getElementById('trh_data_editor_modal')) break;
            await new Promise(r => setTimeout(r, 40));
        }
    })()`);
    assert.equal(
        await evaluate(`window.SillyTavern.getContext().characters.find(c => c.avatar === 'SuMuqing.png').description`),
        '江南药王谷传人，已通过内部编辑器更新描述。'
    );

    // 7. 验证删除时页面不跳到最上面、确认按钮靠右，并成功删除角色卡
    await evaluate(`(() => {
        const inspector = document.querySelector('.trh-inspector');
        inspector.scrollTop = 180;
        window.scrollBeforeDeletePrompt = inspector.scrollTop;
        document.getElementById('trh_delete_resource_btn').click();
    })()`);
    await new Promise(r => setTimeout(r, 80));
    const deleteLayout = await evaluate(`(() => {
        const inspector = document.querySelector('.trh-inspector');
        const confirmBtn = document.getElementById('trh_confirm_delete_btn');
        const cancelBtn = confirmBtn.previousElementSibling;
        return {
            scrollPreserved: inspector.scrollTop >= window.scrollBeforeDeletePrompt - 5,
            confirmOnRight: confirmBtn.getBoundingClientRect().left > cancelBtn.getBoundingClientRect().left,
        };
    })()`);
    assert.deepEqual(deleteLayout, { scrollPreserved: true, confirmOnRight: true });

    await evaluate(`(async () => {
        document.getElementById('trh_confirm_delete_btn').click();
        for (let i = 0; i < 40; i++) {
            if (document.querySelectorAll('.trh-char-card').length === 2) break;
            await new Promise(r => setTimeout(r, 40));
        }
    })()`);
    assert.equal(await evaluate(`document.querySelectorAll('.trh-char-card').length`), 2, '确认删除后角色卡数量减少为 2');

    // 8. 验证 dispose 生命周期完整清理
    await evaluate(`window.trhDispose()`);
    const cleaned = await evaluate(`[
        Boolean(document.getElementById('tavern_resource_hub_overlay')),
        Boolean(document.getElementById('tavern_resource_hub_launcher')),
        Boolean(document.getElementById('tavern_resource_hub_wand_item'))
    ]`);
    assert.deepEqual(cleaned, [false, false, false]);
    assert.equal(exceptions.length, 0, `运行期出现未捕获异常: ${JSON.stringify(exceptions)}`);

    console.log('PASS: Browser E2E & visual checks completed with 0 exceptions.');
    socket.close();
} finally {
    server.close();
    browser.kill();
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
