import test from 'node:test';
import assert from 'node:assert/strict';
import { BindingStore } from '../binding-store.js';
import { inspectResourceBytes } from '../url-resolver.js';
import { UpdateEngine } from '../update-engine.js';
import { PlatformAdapter } from '../platform.js';

function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
}

function createMockHostContext() {
    return {
        characterId: 0,
        extensionSettings: {},
        chatCompletionSettings: {
            preset_settings_openai: '日常写作预设',
            chat_completion_source: 'custom',
            custom_url: 'https://my-private-api.example.com/v1',
            custom_model: 'claude-3-7-sonnet',
            reverse_proxy: 'https://my-proxy.example.com',
            proxy_password: 'keep-my-secret-proxy-pass',
        },
        characters: [
            {
                name: '爱丽丝',
                avatar: 'Alice.png',
                chat: 'Alice - 2026-11-20-existing-chat',
                create_date: '2026-10-01',
                fav: true,
                description: '旧版角色描述 v1.0',
                personality: '温柔谨慎',
                scenario: '旧书店',
                first_mes: '你好，我是旧版开场白（用户本地微调过）。',
                mes_example: '',
                tags: ['奇幻'],
                data: {
                    name: '爱丽丝',
                    description: '旧版角色描述 v1.0',
                    personality: '温柔谨慎',
                    scenario: '旧书店',
                    first_mes: '你好，我是旧版开场白（用户本地微调过）。',
                    character_version: '1.0.0',
                    alternate_greetings: ['旧候选开场白1'],
                    extensions: {
                        world: '用户本地绑定的主世界书',
                        fav: true,
                        regex_scripts: [{ id: 'local-rx', scriptName: '本地正则' }],
                        tavern_helper: {
                            scripts: [{ id: 's1', name: '旧脚本 v1' }],
                            variables: { userCustomTheme: 'dark-gold', affection: 88 },
                        },
                    },
                },
            },
        ],
        presets: {
            '日常写作预设': {
                temperature: 0.7,
                openai_max_context: 32000,
                chat_completion_source: 'custom',
                custom_url: 'https://my-private-api.example.com/v1',
                custom_model: 'claude-3-7-sonnet',
                reverse_proxy: 'https://my-proxy.example.com',
                prompts: [
                    { identifier: 'main', name: '主提示词', role: 'system', content: '旧版主提示词', enabled: true },
                    { identifier: 'nsfw_toggle', name: '可选模块', role: 'system', content: '旧模块内容', enabled: false },
                ],
                extensions: {
                    tavern_helper: {
                        scripts: [{ id: 'ps1', name: '预设脚本 v1' }],
                        variables: { statusColor: '#38D399' },
                    },
                },
            },
        },
        worldbooks: {
            '用户本地绑定的主世界书': {
                entries: {
                    0: { uid: 0, key: ['旧词条'], comment: '本地条目', content: '旧设定内容', disable: false },
                },
            },
        },
        saveSettingsDebounced() {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
}

test('Character Card in-place update preserves avatar ID, chat history, local worldbook binding, and helper variables while syncing embedded book and supporting rollback', async () => {
    const context = createMockHostContext();
    const store = new BindingStore({
        getContext: () => context,
        storage: createMemoryStorage(),
    });

    const remoteCardJson = JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: '爱丽丝',
            description: '全新升级的角色描述 v2.0，增加了第二章背景。',
            personality: '温柔坚毅',
            scenario: '王都大图书馆',
            first_mes: '欢迎来到王都大图书馆，我是新版开场白！',
            character_version: '2.0.0',
            alternate_greetings: ['新版候选开场白A', '新版候选开场白B'],
            character_book: {
                name: '爱丽丝内置世界书v2',
                entries: [
                    { id: 1, keys: ['大图书馆'], comment: '核心地点', content: '收藏着失落纪元的手稿。', enabled: true },
                    { id: 2, keys: ['禁书区'], comment: '地下三层', content: '唯有馆长持有钥匙。', enabled: true },
                ],
            },
            extensions: {
                world: '作者自带世界书名称',
                fav: false,
                regex_scripts: [{ id: 'new-rx-1', scriptName: '新版状态栏正则' }],
                tavern_helper: {
                    scripts: [{ id: 's2', name: '新版界面脚本 v2.0' }],
                    variables: { userCustomTheme: 'default', affection: 0 },
                },
            },
        },
    });

    const inspection = await inspectResourceBytes(remoteCardJson, {
        fileName: 'Alice_v2.json',
        sourceUrl: 'https://raw.githubusercontent.com/author/cards/main/Alice.json',
    });

    // 1. 验证更新预览对比
    const preview = await UpdateEngine.buildUpdatePreview({
        type: 'character',
        localData: context.characters[0],
        remoteInspection: inspection,
    });
    assert.equal(preview.isIdentical, false);
    assert.equal(preview.localVersion, '1.0.0');
    assert.equal(preview.remoteVersion, '2.0.0');
    assert.ok(preview.changedFields.some(f => f.includes('角色描述')));
    assert.ok(preview.changedFields.some(f => f.includes('酒馆助手脚本')));

    // 2. 执行原地无损更新
    const result = await UpdateEngine.updateCharacterInPlace({
        context,
        store,
        avatarId: 'Alice.png',
        remoteInspection: inspection,
        options: {
            preserveWorldbookBinding: true,
            syncEmbeddedWorldbook: true,
            preserveFavorite: true,
            preserveHelperVariables: true,
            preserveFirstMessage: false,
            preserveRegexScripts: false,
        },
        fetchImpl: async () => new Response('{}', { status: 200 }),
    });

    assert.equal(result.ok, true);
    assert.equal(context.characters.length, 1, '绝不能产生重复角色卡');
    const updatedChar = context.characters[0];

    // 聊天会话与头像文件 ID 100% 保留
    assert.equal(updatedChar.avatar, 'Alice.png');
    assert.equal(updatedChar.chat, 'Alice - 2026-11-20-existing-chat');
    assert.equal(updatedChar.fav, true, '保留本地收藏状态');

    // 新版设定、开场白与酒馆助手脚本已更新
    assert.equal(updatedChar.description, '全新升级的角色描述 v2.0，增加了第二章背景。');
    assert.equal(updatedChar.data.character_version, '2.0.0');
    assert.equal(updatedChar.first_mes, '欢迎来到王都大图书馆，我是新版开场白！');
    assert.equal(updatedChar.data.alternate_greetings.length, 2);
    assert.equal(updatedChar.data.extensions.tavern_helper.scripts[0].name, '新版界面脚本 v2.0');

    // 酒馆助手中的用户本地变量未被重置
    assert.deepEqual(updatedChar.data.extensions.tavern_helper.variables, {
        userCustomTheme: 'dark-gold',
        affection: 88,
    });

    // 本地绑定的世界书名称保持不变，且卡内自带的新世界书词条已同步写入该世界书
    assert.equal(updatedChar.data.extensions.world, '用户本地绑定的主世界书');
    assert.equal(Object.keys(context.worldbooks['用户本地绑定的主世界书'].entries).length, 2);

    // 绑定源 URL 已持久化
    const savedBinding = store.getBinding('character', 'Alice.png');
    assert.equal(savedBinding.sourceUrl, 'https://raw.githubusercontent.com/author/cards/main/Alice.json');
    assert.equal(savedBinding.lastVersion, '2.0.0');

    // 3. 验证一键回滚到更新前版本
    await UpdateEngine.rollbackResource({
        context,
        store,
        type: 'character',
        id: 'Alice.png',
        fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    assert.equal(context.characters[0].data.character_version, '1.0.0');
    assert.equal(context.characters[0].description, '旧版角色描述 v1.0');
    assert.equal(context.characters[0].chat, 'Alice - 2026-11-20-existing-chat');
});

test('Preset in-place update updates prompts and helper scripts while protecting local API connection fields and prompt toggles', async () => {
    const context = createMockHostContext();
    const store = new BindingStore({
        getContext: () => context,
        storage: createMemoryStorage(),
    });

    // 远端作者导出的预设带有作者自己的反代地址与模型
    const remotePresetJson = JSON.stringify({
        temperature: 1.05,
        openai_max_context: 128000,
        chat_completion_source: 'openai',
        custom_url: 'https://authors-broken-endpoint.invalid/v1',
        custom_model: 'gpt-4-turbo-author',
        reverse_proxy: 'https://authors-proxy.invalid',
        prompts: [
            { identifier: 'main', name: '主提示词', role: 'system', content: '新版主提示词 v3.0', enabled: true },
            { identifier: 'nsfw_toggle', name: '可选模块', role: 'system', content: '新版模块内容 v3.0', enabled: true },
            { identifier: 'style_guide', name: '新增文风指南', role: 'system', content: '细腻心理描写', enabled: true },
        ],
        extensions: {
            tavern_helper: {
                scripts: [{ id: 'ps2', name: '预设脚本 v3.0' }],
                variables: { statusColor: '#000000' },
            },
        },
    });

    const inspection = await inspectResourceBytes(remotePresetJson, {
        fileName: '日常写作预设.json',
        sourceUrl: 'https://raw.githubusercontent.com/author/presets/main/DailyWriting.json',
    });

    await UpdateEngine.updatePresetInPlace({
        context,
        store,
        presetName: '日常写作预设',
        remoteInspection: inspection,
        options: {
            protectConnectionFields: true,
            preservePromptToggles: true,
            preserveHelperVariables: true,
        },
        fetchImpl: async () => new Response(JSON.stringify({ name: '日常写作预设' }), { status: 200 }),
    });

    const updatedPreset = context.presets['日常写作预设'];

    // 采样与提示词内容已更新为新版
    assert.equal(updatedPreset.temperature, 1.05);
    assert.equal(updatedPreset.openai_max_context, 128000);
    assert.equal(updatedPreset.prompts.length, 3);
    assert.equal(updatedPreset.prompts[0].content, '新版主提示词 v3.0');
    assert.equal(updatedPreset.prompts[1].content, '新版模块内容 v3.0');

    // 本地开关状态已保留（用户在本地关闭了 nsfw_toggle，即使远端默认开启也保持关闭）
    assert.equal(updatedPreset.prompts[1].enabled, false);

    // 本地 API 连接地址与模型完好无损，未被远端预设覆盖
    assert.equal(updatedPreset.chat_completion_source, 'custom');
    assert.equal(updatedPreset.custom_url, 'https://my-private-api.example.com/v1');
    assert.equal(updatedPreset.custom_model, 'claude-3-7-sonnet');
    assert.equal(updatedPreset.reverse_proxy, 'https://my-proxy.example.com');

    // 酒馆助手脚本已升至 v3.0，同时保留用户本地变量
    assert.equal(updatedPreset.extensions.tavern_helper.scripts[0].name, '预设脚本 v3.0');
    assert.equal(updatedPreset.extensions.tavern_helper.variables.statusColor, '#38D399');
});

test('PlatformAdapter.listWorldbooks supports TauriTavern /api/settings/get world_names fallback when /api/worldinfo/list is unavailable', async () => {
    const prevTauriFlag = globalThis.window;
    globalThis.window = { __TAURITAVERN__: true };

    try {
        const mockContext = {
            characters: [],
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        };

        const mockFetch = async (url, init) => {
            if (url === '/api/settings/get') {
                return new Response(JSON.stringify({ world_names: ['赛博朋克2077设定集'] }), { status: 200 });
            }
            if (url === '/api/worldinfo/list') {
                return new Response('Not Found', { status: 404 });
            }
            if (url === '/api/worldinfo/get') {
                const body = JSON.parse(init.body);
                return new Response(JSON.stringify({
                    entries: {
                        0: { uid: 0, key: ['夜之城'], comment: `${body.name}-核心`, content: '荒坂塔矗立于市中心。', disable: false },
                    },
                }), { status: 200 });
            }
            return new Response('{}', { status: 404 });
        };

        const books = await PlatformAdapter.listWorldbooks(mockContext, { fetchImpl: mockFetch });
        assert.equal(books.length, 1);
        assert.equal(books[0].name, '赛博朋克2077设定集');
        assert.equal(books[0].entryCount, 1);
    } finally {
        globalThis.window = prevTauriFlag;
    }
});

test('PlatformAdapter.deleteResource deletes characters, presets, and worldbooks and cleans host state', async () => {
    const context = createMockHostContext();
    const apiCalls = [];
    const mockFetch = async (url, init) => {
        apiCalls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await PlatformAdapter.deleteResource(context, 'character', 'Alice.png', { deleteChats: true, fetchImpl: mockFetch });
    assert.equal(context.characters.length, 0);
    assert.deepEqual(apiCalls[0], { url: '/api/characters/delete', body: { avatar_url: 'Alice.png', delete_chats: true } });

    await PlatformAdapter.deleteResource(context, 'preset', '日常写作预设', { fetchImpl: mockFetch });
    assert.equal('日常写作预设' in context.presets, false);
    assert.deepEqual(apiCalls[1], { url: '/api/presets/delete', body: { name: '日常写作预设', apiId: 'openai' } });

    await PlatformAdapter.deleteResource(context, 'worldbook', '用户本地绑定的主世界书', { fetchImpl: mockFetch });
    assert.equal('用户本地绑定的主世界书' in context.worldbooks, false);
    assert.deepEqual(apiCalls[2], { url: '/api/worldinfo/delete', body: { name: '用户本地绑定的主世界书' } });
});

test('buildUpdatePreview reports isIdentical=true when character or preset matches remote content despite local runtime/protected fields', async () => {
    const context = createMockHostContext();

    // 1. 同版本角色卡（本地带有 avatar, chat, fav, world 绑定, tavern_helper.variables）
    const sameCharRemote = await inspectResourceBytes(JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: '爱丽丝',
            description: '旧版角色描述 v1.0',
            personality: '温柔谨慎',
            scenario: '旧书店',
            first_mes: '你好，我是旧版开场白（用户本地微调过）。',
            character_version: '1.0.0',
            alternate_greetings: ['旧候选开场白1'],
            tags: ['奇幻'],
            extensions: {
                world: '作者原世界书名称',
                fav: false,
                regex_scripts: [{ id: 'local-rx', scriptName: '本地正则' }],
                tavern_helper: {
                    scripts: [{ id: 's1', name: '旧脚本 v1' }],
                    variables: { userCustomTheme: 'default', affection: 0 },
                },
            },
        },
    }), { fileName: 'Alice.json' });

    const charPreview = await UpdateEngine.buildUpdatePreview({
        type: 'character',
        localData: context.characters[0],
        remoteInspection: sameCharRemote,
    });
    assert.equal(charPreview.isIdentical, true);
    assert.equal(charPreview.changedFields.length, 0);

    // 2. 同版本预设（本地带有用户的 custom_url, custom_model 与 tavern_helper.variables）
    const samePresetRemote = await inspectResourceBytes(JSON.stringify({
        temperature: 0.7,
        openai_max_context: 32000,
        chat_completion_source: 'openai',
        custom_url: 'https://authors-other-url.invalid/v1',
        custom_model: 'other-model',
        prompts: [
            { identifier: 'main', name: '主提示词', role: 'system', content: '旧版主提示词', enabled: true },
            { identifier: 'nsfw_toggle', name: '可选模块', role: 'system', content: '旧模块内容', enabled: false },
        ],
        extensions: {
            tavern_helper: {
                scripts: [{ id: 'ps1', name: '预设脚本 v1' }],
                variables: { statusColor: '#000000' },
            },
        },
    }), { fileName: '日常写作预设.json' });

    const presetPreview = await UpdateEngine.buildUpdatePreview({
        type: 'preset',
        localData: context.presets['日常写作预设'],
        remoteInspection: samePresetRemote,
    });
    assert.equal(presetPreview.isIdentical, true);
    assert.equal(presetPreview.changedFields.length, 0);
});
