import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractResourceUrl,
    normalizeResourceUrl,
    classifyJsonResource,
    inspectResourceBytes,
    fetchAndInspectUrl,
} from '../url-resolver.js';
import { encodePngCharacterCard, MINIMAL_1X1_PNG } from '../card-codec.js';

test('normalizeResourceUrl transforms GitHub, Gist, GitLab, and HuggingFace links to Raw URLs', () => {
    const gh = normalizeResourceUrl('https://github.com/user/repo/blob/main/cards/Alice.png');
    assert.equal(gh.resolvedUrl, 'https://raw.githubusercontent.com/user/repo/main/cards/Alice.png');
    assert.equal(gh.transformed, true);
    assert.equal(gh.suggestedFilename, 'Alice.png');

    const gist = normalizeResourceUrl('https://gist.github.com/author/1234567890abcdef');
    assert.equal(gist.resolvedUrl, 'https://gist.githubusercontent.com/author/1234567890abcdef/raw');
    assert.equal(gist.transformed, true);

    const gl = normalizeResourceUrl('https://gitlab.com/team/presets/-/blob/master/ProsePreset.json');
    assert.equal(gl.resolvedUrl, 'https://gitlab.com/team/presets/-/raw/master/ProsePreset.json');
    assert.equal(gl.transformed, true);

    const hf = normalizeResourceUrl('https://huggingface.co/org/cards/blob/main/World.json');
    assert.equal(hf.resolvedUrl, 'https://huggingface.co/org/cards/resolve/main/World.json');
    assert.equal(hf.transformed, true);
});

test('normalizeResourceUrl applies optional GitHub mirror prefix and blocks unsafe protocols', () => {
    const mirrored = normalizeResourceUrl('https://github.com/user/repo/blob/main/preset.json', {
        githubMirrorPrefix: 'https://ghfast.top/',
    });
    assert.equal(
        mirrored.resolvedUrl,
        'https://ghfast.top/https://raw.githubusercontent.com/user/repo/main/preset.json'
    );

    assert.throws(() => normalizeResourceUrl('javascript:alert(1)'), /仅支持 HTTP \/ HTTPS/);
    assert.throws(() => normalizeResourceUrl('file:///C:/secret.json'), /仅支持 HTTP \/ HTTPS/);
    assert.throws(() => normalizeResourceUrl(''), /请输入有效/);
});

test('extractResourceUrl & normalizeResourceUrl extract URL from Chinese description text and Markdown links', () => {
    const withChinese = '【角色卡更新】星野梦 v2.4 下载链接：https://github.com/user/repo/blob/main/Alice.png（推荐搭配破限预设，勿商用）';
    assert.equal(extractResourceUrl(withChinese), 'https://github.com/user/repo/blob/main/Alice.png');
    const resolved = normalizeResourceUrl(withChinese);
    assert.equal(resolved.originalUrl, 'https://github.com/user/repo/blob/main/Alice.png');
    assert.equal(resolved.resolvedUrl, 'https://raw.githubusercontent.com/user/repo/main/Alice.png');

    const markdownText = '点击这里下载：[预设文件](https://example.com/presets/Prose_v3.json)，包含正则与助手脚本。';
    assert.equal(extractResourceUrl(markdownText), 'https://example.com/presets/Prose_v3.json');
});

test('inspectResourceBytes auto-detects PNG character cards, JSON character cards, presets, and worldbooks', async () => {
    // 1. PNG Character Card
    const cardPayload = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: '星野梦',
            description: '一位守护旧书店的神秘少女。',
            first_mes: '欢迎光临，今天想找哪一本书？',
            character_version: '2.1.0',
            alternate_greetings: ['雨停了呢，进来喝杯热茶吧。'],
            extensions: {
                regex_scripts: [{ id: 'r1', scriptName: '思考隐藏' }],
                tavern_helper: { scripts: [{ type: 'script', name: '状态栏' }], variables: { affection: 50 } },
            },
        },
    };
    const pngBytes = encodePngCharacterCard(MINIMAL_1X1_PNG, cardPayload);
    const pngInspect = await inspectResourceBytes(pngBytes, { fileName: '星野梦.png' });
    assert.equal(pngInspect.type, 'character');
    assert.equal(pngInspect.format, 'png');
    assert.equal(pngInspect.name, '星野梦');
    assert.equal(pngInspect.version, '2.1.0');
    assert.equal(pngInspect.summary.greetingCount, 2);
    assert.equal(pngInspect.summary.regexCount, 1);
    assert.equal(pngInspect.summary.helperScriptCount, 1);

    // 2. Preset JSON
    const presetJson = JSON.stringify({
        temperature: 0.85,
        openai_max_context: 64000,
        prompts: [
            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Write vividly.', enabled: true },
            { identifier: 'cot', name: 'CoT', role: 'system', content: '<think>', enabled: false },
        ],
        extensions: {
            tavern_helper: { scripts: [{ type: 'script', name: '预设脚本' }] },
        },
    });
    const presetInspect = await inspectResourceBytes(presetJson, { fileName: '破限文风v3.json' });
    assert.equal(presetInspect.type, 'preset');
    assert.equal(presetInspect.name, '破限文风v3');
    assert.equal(presetInspect.summary.promptCount, 2);
    assert.equal(presetInspect.summary.enabledPromptCount, 1);
    assert.equal(presetInspect.summary.helperScriptCount, 1);

    // 3. Worldbook JSON
    const wbJson = JSON.stringify({
        name: '艾尔登法环设定集',
        entries: {
            0: { uid: 0, key: ['交界地', '黄金树'], comment: '地理总览', content: '黄金树矗立于交界地中央。', disable: false },
        },
    });
    const wbInspect = await inspectResourceBytes(wbJson, { fileName: 'elden.json' });
    assert.equal(wbInspect.type, 'worldbook');
    assert.equal(wbInspect.name, '艾尔登法环设定集');
    assert.equal(wbInspect.summary.entryCount, 1);

    // 4. Rejects HTML webpage masquerading as raw file
    await assert.rejects(
        () => inspectResourceBytes('<!DOCTYPE html><html><body>Not found</body></html>'),
        /返回的是 HTML 网页而非原始文件/
    );
});

test('fetchAndInspectUrl resolves GitHub URL and parses remote payload via custom fetch', async () => {
    const requestedUrls = [];
    const mockFetch = async (url) => {
        requestedUrls.push(url);
        const body = JSON.stringify({
            name: '测试世界书',
            entries: [{ id: 1, keys: ['学院'], content: '魔法学院设定', enabled: true }],
        });
        return new Response(body, { status: 200 });
    };

    const result = await fetchAndInspectUrl('https://github.com/creator/lore/blob/main/Academy.json', {
        fetchImpl: mockFetch,
    });

    assert.equal(requestedUrls[0], 'https://raw.githubusercontent.com/creator/lore/main/Academy.json');
    assert.equal(result.type, 'worldbook');
    assert.equal(result.name, '测试世界书');
    assert.equal(result.summary.entryCount, 1);
});
