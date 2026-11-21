/**
 * Tavern-Resource-Hub: Card, Preset & Worldbook Codec
 * 纯前端实现 PNG 角色卡 (tEXt / iTXt / zTXt: chara & ccv3) 解析与重封装，
 * 以及角色卡 (V1/V2/V3)、世界书 (World Info / Character Book)、预设 (Preset) 的格式规范化。
 */

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// 最小 1x1 透明 PNG（用于纯 JSON 角色卡需要转换为 PNG 容器时的回退基底）
export const MINIMAL_1X1_PNG = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
    0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180,
    0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

// CRC32 查找表（用于重写 PNG tEXt chunk）
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function isPngBytes(bytes) {
    if (!bytes || bytes.length < 8) return false;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < 8; i++) {
        if (u8[i] !== PNG_SIGNATURE[i]) return false;
    }
    return true;
}

/**
 * UTF-8 安全的 Base64 编解码（避免直接 atob/btoa 导致中文乱码）
 */
export function encodeBase64Utf8(str) {
    const bytes = new TextEncoder().encode(String(str));
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

export function decodeBase64Utf8(b64) {
    const clean = String(b64 || '').replace(/[\r\n\s]+/g, '');
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        return Buffer.from(clean, 'base64').toString('utf8');
    }
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

async function inflateZlibBytes(compressed) {
    if (typeof process !== 'undefined' && process.versions?.node) {
        const zlib = await import('node:zlib');
        return new Uint8Array(zlib.inflateSync(compressed));
    }
    if (typeof DecompressionStream === 'function') {
        const ds = new DecompressionStream('deflate');
        const stream = new Blob([compressed]).stream().pipeThrough(ds);
        const ab = await new Response(stream).arrayBuffer();
        return new Uint8Array(ab);
    }
    throw new Error('当前环境不支持解析压缩的 PNG zTXt 数据块');
}

function readUint32BE(u8, offset) {
    return (
        ((u8[offset] << 24) >>> 0) +
        ((u8[offset + 1] << 16) >>> 0) +
        ((u8[offset + 2] << 8) >>> 0) +
        u8[offset + 3]
    ) >>> 0;
}

function writeUint32BE(u8, offset, value) {
    u8[offset] = (value >>> 24) & 0xff;
    u8[offset + 1] = (value >>> 16) & 0xff;
    u8[offset + 2] = (value >>> 8) & 0xff;
    u8[offset + 3] = value & 0xff;
}

/**
 * 从 PNG 字节流中解析嵌入的角色卡元数据 (支持 tEXt / iTXt / zTXt 的 ccv3 与 chara)
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Promise<{ rawJson: Object, keyword: 'ccv3'|'chara', normalized: Object }>}
 */
export async function parsePngCharacterCard(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isPngBytes(u8)) {
        throw new Error('无效的 PNG 文件头');
    }

    const foundChunks = {};
    const latin1Decoder = new TextDecoder('latin1');
    const utf8Decoder = new TextDecoder('utf-8');
    let offset = 8;

    while (offset + 8 <= u8.length) {
        const length = readUint32BE(u8, offset);
        const type = latin1Decoder.decode(u8.subarray(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > u8.length) {
            break;
        }
        const chunkData = u8.subarray(dataStart, dataEnd);

        if (type === 'tEXt') {
            const nullIdx = chunkData.indexOf(0);
            if (nullIdx > 0) {
                const keyword = latin1Decoder.decode(chunkData.subarray(0, nullIdx)).toLowerCase();
                if (keyword === 'chara' || keyword === 'ccv3') {
                    const textValue = latin1Decoder.decode(chunkData.subarray(nullIdx + 1));
                    foundChunks[keyword] = textValue;
                }
            }
        } else if (type === 'zTXt') {
            const nullIdx = chunkData.indexOf(0);
            if (nullIdx > 0 && nullIdx + 2 <= chunkData.length) {
                const keyword = latin1Decoder.decode(chunkData.subarray(0, nullIdx)).toLowerCase();
                if (keyword === 'chara' || keyword === 'ccv3') {
                    const compressed = chunkData.subarray(nullIdx + 2);
                    const inflated = await inflateZlibBytes(compressed);
                    foundChunks[keyword] = utf8Decoder.decode(inflated);
                }
            }
        } else if (type === 'iTXt') {
            const nullIdx = chunkData.indexOf(0);
            if (nullIdx > 0 && nullIdx + 3 <= chunkData.length) {
                const keyword = latin1Decoder.decode(chunkData.subarray(0, nullIdx)).toLowerCase();
                if (keyword === 'chara' || keyword === 'ccv3') {
                    const compFlag = chunkData[nullIdx + 1];
                    let cursor = nullIdx + 3;
                    // Skip language tag & translated keyword (two null-terminated strings)
                    for (let s = 0; s < 2; s++) {
                        const nextNull = chunkData.indexOf(0, cursor);
                        if (nextNull === -1) {
                            cursor = chunkData.length;
                            break;
                        }
                        cursor = nextNull + 1;
                    }
                    const payloadBytes = chunkData.subarray(cursor);
                    if (compFlag === 1) {
                        const inflated = await inflateZlibBytes(payloadBytes);
                        foundChunks[keyword] = utf8Decoder.decode(inflated);
                    } else {
                        foundChunks[keyword] = utf8Decoder.decode(payloadBytes);
                    }
                }
            }
        } else if (type === 'IEND') {
            break;
        }

        offset = dataEnd + 4;
    }

    const chosenKeyword = foundChunks.ccv3 ? 'ccv3' : (foundChunks.chara ? 'chara' : null);
    if (!chosenKeyword) {
        throw new Error('该 PNG 图片中未检测到角色卡元数据块 (chara / ccv3)');
    }

    let decodedText = foundChunks[chosenKeyword].trim();
    let rawJson;
    try {
        if (decodedText.startsWith('{')) {
            rawJson = JSON.parse(decodedText);
        } else {
            rawJson = JSON.parse(decodeBase64Utf8(decodedText));
        }
    } catch (err) {
        throw new Error(`角色卡 PNG 元数据 JSON 解析失败: ${err.message}`);
    }

    return {
        keyword: chosenKeyword,
        rawJson,
        normalized: normalizeCharacterPayload(rawJson),
    };
}

function buildTextChunk(keyword, base64Payload) {
    const encoder = new TextEncoder();
    const keyBytes = encoder.encode(keyword);
    const valBytes = encoder.encode(base64Payload);
    const dataLength = keyBytes.length + 1 + valBytes.length;
    const chunk = new Uint8Array(4 + 4 + dataLength + 4);

    writeUint32BE(chunk, 0, dataLength);
    // 'tEXt'
    chunk[4] = 116;
    chunk[5] = 69;
    chunk[6] = 88;
    chunk[7] = 116;

    chunk.set(keyBytes, 8);
    chunk[8 + keyBytes.length] = 0;
    chunk.set(valBytes, 8 + keyBytes.length + 1);

    const crc = crc32(chunk.subarray(4, 8 + dataLength));
    writeUint32BE(chunk, 8 + dataLength, crc);
    return chunk;
}

/**
 * 将角色卡 V2/V3 JSON 数据重新写入 PNG 字节流（移除旧的 chara/ccv3 块，在 IEND 前写入新块）
 * @param {Uint8Array|ArrayBuffer} pngInput
 * @param {Object} v2CardObject 完整的 V2/V3 角色卡对象
 * @returns {Uint8Array}
 */
export function encodePngCharacterCard(pngInput, v2CardObject) {
    const u8 = pngInput instanceof Uint8Array ? pngInput : new Uint8Array(pngInput);
    if (!isPngBytes(u8)) {
        throw new Error('无法向非 PNG 字节流写入角色卡元数据');
    }

    const latin1Decoder = new TextDecoder('latin1');
    const keptChunks = [u8.subarray(0, 8)];
    let iendChunk = null;
    let offset = 8;

    while (offset + 8 <= u8.length) {
        const length = readUint32BE(u8, offset);
        const type = latin1Decoder.decode(u8.subarray(offset + 4, offset + 8));
        const chunkTotal = 12 + length;
        if (offset + chunkTotal > u8.length) break;

        const fullChunk = u8.subarray(offset, offset + chunkTotal);
        if (type === 'IEND') {
            iendChunk = fullChunk;
            break;
        }

        let isOldCardChunk = false;
        if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
            const data = u8.subarray(offset + 8, offset + 8 + length);
            const nullIdx = data.indexOf(0);
            if (nullIdx > 0) {
                const kw = latin1Decoder.decode(data.subarray(0, nullIdx)).toLowerCase();
                if (kw === 'chara' || kw === 'ccv3') {
                    isOldCardChunk = true;
                }
            }
        }

        if (!isOldCardChunk) {
            keptChunks.push(fullChunk);
        }
        offset += chunkTotal;
    }

    const jsonString = JSON.stringify(v2CardObject);
    const b64 = encodeBase64Utf8(jsonString);
    keptChunks.push(buildTextChunk('chara', b64));

    if (v2CardObject?.spec === 'chara_card_v3') {
        keptChunks.push(buildTextChunk('ccv3', b64));
    }

    if (iendChunk) {
        keptChunks.push(iendChunk);
    } else {
        keptChunks.push(new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
    }

    const totalLen = keptChunks.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(totalLen);
    let writePos = 0;
    for (const part of keptChunks) {
        output.set(part, writePos);
        writePos += part.length;
    }
    return output;
}

/**
 * 规范化 V1 / V2 / V3 角色卡 JSON，提取统一的顶层与 data 字段，同时完整保留未知的 extensions
 * @param {Object} raw
 */
export function normalizeCharacterPayload(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('角色卡数据不是有效的 JSON 对象');
    }

    const d = (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) ? raw.data : {};
    const ext = {
        ...(raw.extensions && typeof raw.extensions === 'object' ? structuredClone(raw.extensions) : {}),
        ...(d.extensions && typeof d.extensions === 'object' ? structuredClone(d.extensions) : {}),
    };

    const name = String(d.name ?? raw.name ?? raw.ch_name ?? '').trim();
    if (!name) {
        throw new Error('角色卡缺少有效的角色名称 (name)');
    }

    const description = String(d.description ?? raw.description ?? '');
    const personality = String(d.personality ?? raw.personality ?? '');
    const scenario = String(d.scenario ?? raw.scenario ?? '');
    const first_mes = String(d.first_mes ?? raw.first_mes ?? '');
    const mes_example = String(d.mes_example ?? raw.mes_example ?? '');
    const creator_notes = String(d.creator_notes ?? raw.creatorcomment ?? raw.creator_notes ?? '');
    const system_prompt = String(d.system_prompt ?? raw.system_prompt ?? '');
    const post_history_instructions = String(d.post_history_instructions ?? raw.post_history_instructions ?? '');
    const creator = String(d.creator ?? raw.creator ?? '');
    const character_version = String(d.character_version ?? raw.character_version ?? '');
    const alternate_greetings = Array.isArray(d.alternate_greetings)
        ? [...d.alternate_greetings]
        : (Array.isArray(raw.alternate_greetings) ? [...raw.alternate_greetings] : []);
    const tags = Array.isArray(d.tags)
        ? [...d.tags]
        : (Array.isArray(raw.tags) ? [...raw.tags] : []);
    const character_book = (d.character_book && typeof d.character_book === 'object')
        ? structuredClone(d.character_book)
        : ((raw.character_book && typeof raw.character_book === 'object') ? structuredClone(raw.character_book) : null);

    const talkativeness = Number.isFinite(Number(ext.talkativeness ?? raw.talkativeness))
        ? Number(ext.talkativeness ?? raw.talkativeness)
        : 0.5;
    const fav = Boolean(ext.fav ?? raw.fav ?? false);

    ext.talkativeness = talkativeness;
    ext.fav = fav;
    if (!Array.isArray(ext.regex_scripts)) {
        ext.regex_scripts = Array.isArray(raw.regex_scripts) ? structuredClone(raw.regex_scripts) : [];
    }

    const spec = raw.spec === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2';
    const spec_version = raw.spec === 'chara_card_v3' ? (raw.spec_version || '3.0') : '2.0';

    const v2Object = {
        name,
        description,
        personality,
        scenario,
        first_mes,
        mes_example,
        creatorcomment: creator_notes,
        avatar: raw.avatar || 'none',
        chat: raw.chat || '',
        talkativeness,
        fav,
        tags,
        spec,
        spec_version,
        data: {
            ...structuredClone(d),
            name,
            description,
            personality,
            scenario,
            first_mes,
            mes_example,
            creator_notes,
            system_prompt,
            post_history_instructions,
            alternate_greetings,
            tags,
            creator,
            character_version,
            character_book,
            extensions: ext,
        },
    };

    const helperScripts = Array.isArray(ext.tavern_helper?.scripts)
        ? ext.tavern_helper.scripts
        : [];

    return {
        name,
        version: character_version,
        creator,
        description,
        personality,
        scenario,
        first_mes,
        mes_example,
        creator_notes,
        system_prompt,
        post_history_instructions,
        alternate_greetings,
        tags,
        character_book,
        extensions: ext,
        regexCount: ext.regex_scripts.length,
        helperScriptCount: helperScripts.length,
        greetingCount: 1 + alternate_greetings.length,
        hasCharacterBook: Boolean(character_book && (
            Array.isArray(character_book.entries)
                ? character_book.entries.length > 0
                : Object.keys(character_book.entries || {}).length > 0
        )),
        v2Object,
    };
}

const POSITION_STRING_TO_INDEX = {
    before_char: 0,
    before_character_definition: 0,
    after_char: 1,
    after_character_definition: 1,
    before_an: 2,
    before_author_note: 2,
    after_an: 3,
    after_author_note: 3,
    at_depth: 4,
    before_example: 5,
    before_example_messages: 5,
    after_example: 6,
    after_example_messages: 6,
};

/**
 * 将单个世界书词条（可能来自 ST World Info 或 V2 character_book）规范化为 ST 标准词条对象
 */
export function normalizeWorldInfoEntry(entry, index = 0) {
    const ext = (entry?.extensions && typeof entry.extensions === 'object') ? entry.extensions : {};
    const uid = Number.isInteger(entry?.uid)
        ? entry.uid
        : (Number.isInteger(entry?.id) ? entry.id : index);

    const key = Array.isArray(entry?.key)
        ? entry.key.map(String)
        : (Array.isArray(entry?.keys) ? entry.keys.map(String) : []);
    const keysecondary = Array.isArray(entry?.keysecondary)
        ? entry.keysecondary.map(String)
        : (Array.isArray(entry?.secondary_keys) ? entry.secondary_keys.map(String) : []);

    const disable = typeof entry?.disable === 'boolean'
        ? entry.disable
        : (typeof entry?.enabled === 'boolean' ? !entry.enabled : false);

    let position = 0;
    if (typeof entry?.position === 'number') {
        position = entry.position;
    } else if (typeof ext.position === 'number') {
        position = ext.position;
    } else if (typeof entry?.position === 'string' && entry.position in POSITION_STRING_TO_INDEX) {
        position = POSITION_STRING_TO_INDEX[entry.position];
    }

    const order = Number.isFinite(Number(entry?.order ?? entry?.insertion_order))
        ? Number(entry?.order ?? entry?.insertion_order)
        : 100;

    const normalized = {
        ...structuredClone(entry),
        uid,
        key,
        keysecondary,
        comment: String(entry?.comment ?? entry?.name ?? ''),
        content: String(entry?.content ?? ''),
        constant: Boolean(entry?.constant ?? false),
        vectorized: Boolean(entry?.vectorized ?? ext.vectorized ?? false),
        selective: typeof entry?.selective === 'boolean' ? entry.selective : true,
        selectiveLogic: Number.isInteger(entry?.selectiveLogic ?? ext.selectiveLogic)
            ? (entry?.selectiveLogic ?? ext.selectiveLogic)
            : 0,
        addMemo: typeof entry?.addMemo === 'boolean' ? entry.addMemo : true,
        order,
        position,
        disable,
        excludeRecursion: Boolean(entry?.excludeRecursion ?? ext.exclude_recursion ?? false),
        preventRecursion: Boolean(entry?.preventRecursion ?? ext.prevent_recursion ?? false),
        delayUntilRecursion: entry?.delayUntilRecursion ?? ext.delay_until_recursion ?? false,
        probability: Number.isFinite(Number(entry?.probability ?? ext.probability))
            ? Number(entry?.probability ?? ext.probability)
            : 100,
        useProbability: typeof entry?.useProbability === 'boolean'
            ? entry.useProbability
            : Boolean(ext.useProbability ?? true),
        depth: Number.isFinite(Number(entry?.depth ?? ext.depth))
            ? Number(entry?.depth ?? ext.depth)
            : 4,
        group: String(entry?.group ?? ext.group ?? ''),
        groupOverride: Boolean(entry?.groupOverride ?? ext.group_override ?? false),
        groupWeight: Number.isFinite(Number(entry?.groupWeight ?? ext.group_weight))
            ? Number(entry?.groupWeight ?? ext.group_weight)
            : 100,
        scanDepth: entry?.scanDepth ?? ext.scan_depth ?? null,
        caseSensitive: entry?.caseSensitive ?? ext.case_sensitive ?? null,
        matchWholeWords: entry?.matchWholeWords ?? ext.match_whole_words ?? null,
        useGroupScoring: entry?.useGroupScoring ?? ext.use_group_scoring ?? null,
        automationId: String(entry?.automationId ?? ext.automation_id ?? ''),
        role: entry?.role ?? ext.role ?? 0,
        sticky: entry?.sticky ?? null,
        cooldown: entry?.cooldown ?? null,
        delay: entry?.delay ?? null,
        displayIndex: Number.isInteger(entry?.displayIndex ?? ext.display_index)
            ? (entry?.displayIndex ?? ext.display_index)
            : index,
    };

    return normalized;
}

/**
 * 规范化世界书 JSON（支持标准 ST `{ entries: { "0": ... } }` 与 V2 Character Book `{ name, entries: [...] }`）
 * @param {Object} raw
 * @returns {{ name: string, entries: Record<string, Object>, entryCount: number, bookData: { entries: Record<string, Object> } }}
 */
export function normalizeWorldbookPayload(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('世界书数据不是有效的 JSON 对象');
    }

    const rawEntries = raw.entries;
    if (!rawEntries || typeof rawEntries !== 'object') {
        throw new Error('世界书缺少 entries 字段');
    }

    const entriesDict = {};
    if (Array.isArray(rawEntries)) {
        rawEntries.forEach((item, idx) => {
            if (!item || typeof item !== 'object') return;
            const norm = normalizeWorldInfoEntry(item, idx);
            const key = String(Number.isInteger(norm.uid) ? norm.uid : idx);
            entriesDict[key] = norm;
        });
    } else {
        let idx = 0;
        for (const [k, item] of Object.entries(rawEntries)) {
            if (!item || typeof item !== 'object') continue;
            const norm = normalizeWorldInfoEntry(item, Number.isInteger(Number(k)) ? Number(k) : idx);
            entriesDict[String(k)] = norm;
            idx++;
        }
    }

    const bookData = {
        ...structuredClone(raw),
        entries: entriesDict,
    };

    return {
        name: String(raw.name || '').trim(),
        entries: entriesDict,
        entryCount: Object.keys(entriesDict).length,
        bookData,
    };
}

/**
 * 检验并提取预设 JSON 元数据（兼容原生 Chat Completion 预设与 TavernHelper 预设结构）
 */
export function inspectPresetPayload(raw, fallbackName = '') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('预设数据不是有效的 JSON 对象');
    }

    const prompts = Array.isArray(raw.prompts) ? raw.prompts : [];
    const ext = (raw.extensions && typeof raw.extensions === 'object') ? raw.extensions : {};
    const regexScripts = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
    const helperScripts = Array.isArray(ext.tavern_helper?.scripts) ? ext.tavern_helper.scripts : [];

    const temperature = raw.temperature ?? raw.temp ?? raw.settings?.temperature ?? null;
    const maxContext = raw.openai_max_context ?? raw.max_context ?? raw.settings?.max_context ?? null;
    const maxTokens = raw.openai_max_tokens ?? raw.max_completion_tokens ?? raw.settings?.max_completion_tokens ?? null;

    return {
        name: String(raw.name || fallbackName || '').trim(),
        version: String(raw.version || ext.version || '').trim(),
        promptCount: prompts.length,
        enabledPromptCount: prompts.filter(p => p && p.enabled !== false && p.system_prompt !== true).length,
        regexCount: regexScripts.length,
        helperScriptCount: helperScripts.length,
        temperature,
        maxContext,
        maxTokens,
        rawPreset: structuredClone(raw),
    };
}
