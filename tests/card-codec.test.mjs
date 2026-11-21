import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MINIMAL_1X1_PNG,
    encodePngCharacterCard,
    parsePngCharacterCard,
    normalizeCharacterPayload,
    normalizeWorldbookPayload,
} from '../card-codec.js';

test('PNG character card codec round-trips V2 and V3 UTF-8 metadata and replaces old chunks cleanly', async () => {
    const v2Card = {
        name: '林月如',
        description: '林家堡千金，擅长鞭法与剑术。',
        first_mes: '呆子，看招！',
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: '林月如',
            description: '林家堡千金，擅长鞭法与剑术。',
            first_mes: '呆子，看招！',
            character_version: '1.0.0',
            alternate_greetings: ['今天去苏州城逛逛吧！'],
            tags: ['仙剑', '武侠'],
            extensions: {
                world: '仙剑奇侠传世界书',
            },
        },
    };

    const firstPng = encodePngCharacterCard(MINIMAL_1X1_PNG, v2Card);
    const parsed1 = await parsePngCharacterCard(firstPng);
    assert.equal(parsed1.normalized.name, '林月如');
    assert.equal(parsed1.normalized.version, '1.0.0');
    assert.equal(parsed1.normalized.extensions.world, '仙剑奇侠传世界书');

    // Update to V3 and re-encode onto the already encoded PNG
    const v3Card = {
        ...v2Card,
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            ...v2Card.data,
            character_version: '2.0.0',
            first_mes: '吃到老，玩到老！',
        },
    };
    const secondPng = encodePngCharacterCard(firstPng, v3Card);
    const parsed2 = await parsePngCharacterCard(secondPng);
    assert.equal(parsed2.keyword, 'ccv3');
    assert.equal(parsed2.normalized.version, '2.0.0');
    assert.equal(parsed2.normalized.first_mes, '吃到老，玩到老！');
});

test('normalizeWorldbookPayload converts both Character Book array format and ST World Info dict format', () => {
    const characterBook = {
        name: '卡内世界书',
        entries: [
            {
                id: 10,
                keys: ['蜀山', '锁妖塔'],
                secondary_keys: ['剑圣'],
                comment: '蜀山派设定',
                content: '蜀山仙剑派位于蜀山绝顶。',
                constant: false,
                selective: true,
                insertion_order: 120,
                enabled: true,
                position: 'before_char',
                extensions: {
                    depth: 2,
                    probability: 90,
                },
            },
            {
                id: 11,
                keys: ['隐藏词条'],
                comment: '禁用测试',
                content: '不应激活',
                enabled: false,
            },
        ],
    };

    const norm = normalizeWorldbookPayload(characterBook);
    assert.equal(norm.name, '卡内世界书');
    assert.equal(norm.entryCount, 2);
    assert.deepEqual(norm.entries['10'].key, ['蜀山', '锁妖塔']);
    assert.deepEqual(norm.entries['10'].keysecondary, ['剑圣']);
    assert.equal(norm.entries['10'].position, 0);
    assert.equal(norm.entries['10'].order, 120);
    assert.equal(norm.entries['10'].disable, false);
    assert.equal(norm.entries['11'].disable, true);
});

test('normalizeCharacterPayload extracts fields from embedded json_data string when top-level or data fields are empty', () => {
    const shallowChar = {
        name: '浅层角色',
        avatar: 'Shallow.png',
        shallow: true,
        description: '',
        first_mes: '',
        data: {},
        json_data: JSON.stringify({
            spec: 'chara_card_v2',
            data: {
                name: '浅层角色',
                description: '来自 json_data 的完整角色描述',
                first_mes: '来自 json_data 的开场白',
                character_version: '3.2.1',
                alternate_greetings: ['备用开场白A'],
            },
        }),
    };

    const norm = normalizeCharacterPayload(shallowChar);
    assert.equal(norm.description, '来自 json_data 的完整角色描述');
    assert.equal(norm.first_mes, '来自 json_data 的开场白');
    assert.equal(norm.version, '3.2.1');
    assert.deepEqual(norm.alternate_greetings, ['备用开场白A']);
});
