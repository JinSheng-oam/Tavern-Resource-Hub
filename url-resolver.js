/**
 * Tavern-Resource-Hub: URL Resolver & Payload Inspector
 * 支持 GitHub / Gist / GitLab / HuggingFace 网页链接自动转 Raw 直链、
 * 可选镜像前缀加速、以及自动嗅探远端载荷类型（角色卡 PNG/JSON、预设 JSON、世界书 JSON）。
 */

import {
    isPngBytes,
    parsePngCharacterCard,
    normalizeCharacterPayload,
    normalizeWorldbookPayload,
    inspectPresetPayload,
} from './card-codec.js';
import { canonicalStringify, sha256Hex } from './binding-store.js';

/**
 * 从可能包含中文说明、换行或 Markdown 标记的混合文本中提取第一个 HTTP/HTTPS 链接
 * @param {string} rawInput
 * @returns {string}
 */
export function extractResourceUrl(rawInput) {
    const text = String(rawInput || '').trim();
    if (!text) {
        throw new Error('请输入有效的 HTTP / HTTPS 资源链接');
    }

    // 显式拒绝非 HTTP(S) 危险协议（如 javascript: / file:）
    if (/^(javascript|data|vbscript|file):/i.test(text)) {
        const proto = text.split(':')[0] + ':';
        throw new Error(`仅支持 HTTP / HTTPS 链接，已拒绝协议: ${proto}`);
    }

    // 匹配 https:// 或 http://，在遇到空白、中文/全角字符或引号/尖括号时停止
    const match = text.match(/https?:\/\/[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef"'<>]+/i);
    if (!match) {
        throw new Error('未在输入内容中检测到有效的 HTTP / HTTPS 链接');
    }

    let extracted = match[0];
    // 剥离链接末尾可能紧跟的英文标点或未配对的右括号（如 Markdown `[名称](url)` 或句末标点）
    while (extracted.length > 8) {
        const lastChar = extracted.at(-1);
        if (lastChar === '.' || lastChar === ',' || lastChar === ';' || lastChar === ':' || lastChar === '!' || lastChar === '?' || lastChar === ']') {
            extracted = extracted.slice(0, -1);
            continue;
        }
        if (lastChar === ')') {
            const openCount = (extracted.match(/\(/g) || []).length;
            const closeCount = (extracted.match(/\)/g) || []).length;
            if (closeCount > openCount) {
                extracted = extracted.slice(0, -1);
                continue;
            }
        }
        break;
    }

    return extracted;
}

/**
 * 将用户粘贴的链接（支持带中文说明的文本）规范化为可直接下载的 Raw 链接
 * @param {string} rawUrl
 * @param {Object} [options]
 * @param {string} [options.githubMirrorPrefix=''] 可选 GitHub 加速前缀（例如 https://ghfast.top/）
 * @returns {{ originalUrl: string, resolvedUrl: string, displayHost: string, suggestedFilename: string, transformed: boolean }}
 */
export function normalizeResourceUrl(rawUrl, { githubMirrorPrefix = '' } = {}) {
    const trimmed = extractResourceUrl(rawUrl);

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(`链接格式无效: ${trimmed}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`仅支持 HTTP / HTTPS 链接，已拒绝协议: ${parsed.protocol}`);
    }

    let resolvedUrl = parsed.toString();
    let transformed = false;

    // 1. GitHub blob / raw -> raw.githubusercontent.com
    if (parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com') {
        const parts = parsed.pathname.split('/').filter(Boolean);
        // /{owner}/{repo}/blob/{branch}/{...path} or /{owner}/{repo}/raw/{branch}/{...path}
        if (parts.length >= 5 && (parts[2] === 'blob' || parts[2] === 'raw')) {
            const [owner, repo, , branch, ...rest] = parts;
            resolvedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join('/')}`;
            transformed = true;
        }
    }

    // 2. GitHub Gist -> gist.githubusercontent.com/.../raw
    if (parsed.hostname === 'gist.github.com') {
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length >= 2 && !parts.includes('raw')) {
            resolvedUrl = `https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`;
            transformed = true;
        }
    }

    // 3. GitLab -> /-/raw/
    if (parsed.pathname.includes('/-/blob/')) {
        resolvedUrl = parsed.toString().replace('/-/blob/', '/-/raw/');
        transformed = true;
    }

    // 4. HuggingFace -> /resolve/
    if ((parsed.hostname === 'huggingface.co' || parsed.hostname.endsWith('.huggingface.co')) && parsed.pathname.includes('/blob/')) {
        resolvedUrl = parsed.toString().replace('/blob/', '/resolve/');
        transformed = true;
    }

    const finalParsed = new URL(resolvedUrl);
    const mirror = String(githubMirrorPrefix || '').trim();
    if (mirror && (finalParsed.hostname === 'raw.githubusercontent.com' || finalParsed.hostname === 'gist.githubusercontent.com')) {
        const cleanMirror = mirror.replace(/\/+$/, '');
        resolvedUrl = `${cleanMirror}/${resolvedUrl}`;
        transformed = true;
    }

    // 提取建议文件名（解码 URI）
    const pathSegments = finalParsed.pathname.split('/').filter(Boolean);
    let lastSegment = pathSegments.at(-1) || 'resource';
    try {
        lastSegment = decodeURIComponent(lastSegment);
    } catch {
        // Keep raw segment
    }

    return {
        originalUrl: trimmed,
        resolvedUrl,
        displayHost: finalParsed.hostname,
        suggestedFilename: lastSegment,
        transformed,
    };
}

/**
 * 判定解析后的 JSON 属于哪种酒馆资源类型：'character' | 'worldbook' | 'preset'
 */
export function classifyJsonResource(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error('JSON 内容不是有效的对象');
    }

    // 1. 角色卡 V2 / V3 明确 spec，或包含典型角色卡字段组合
    if (
        json.spec === 'chara_card_v2' ||
        json.spec === 'chara_card_v3' ||
        (json.data && typeof json.data === 'object' && typeof json.data.first_mes === 'string' && typeof json.data.name === 'string') ||
        (typeof json.name === 'string' && typeof json.first_mes === 'string' && ('description' in json || 'personality' in json || 'mes_example' in json))
    ) {
        return 'character';
    }

    // 2. 世界书：包含 entries（数组或字典）且不是角色卡或预设
    if (json.entries && typeof json.entries === 'object' && !Array.isArray(json.prompts)) {
        return 'worldbook';
    }

    // 3. 预设：包含 prompts 数组，或 prompt_order，或典型采样参数
    if (
        Array.isArray(json.prompts) ||
        Array.isArray(json.prompt_order) ||
        'openai_max_context' in json ||
        'chat_completion_source' in json ||
        (json.settings && typeof json.settings === 'object' && ('max_context' in json.settings || 'temperature' in json.settings))
    ) {
        return 'preset';
    }

    throw new Error('无法识别该 JSON 文件的资源类型（既不是角色卡，也不是预设或世界书）');
}

function stripExtension(filename) {
    return String(filename || '')
        .replace(/\.(png|json|card|lorebook|worldbook)$/i, '')
        .trim();
}

/**
 * 解析并校验二进制或文本载荷，自动识别为角色卡、预设或世界书，并计算稳定内容哈希
 * @param {Uint8Array|ArrayBuffer|string} payload
 * @param {Object} [meta]
 * @param {string} [meta.fileName='']
 * @param {string} [meta.sourceUrl='']
 * @returns {Promise<Object>}
 */
export async function inspectResourceBytes(payload, { fileName = '', sourceUrl = '' } = {}) {
    let bytes;
    if (typeof payload === 'string') {
        bytes = new TextEncoder().encode(payload);
    } else if (payload instanceof Uint8Array) {
        bytes = payload;
    } else if (payload instanceof ArrayBuffer) {
        bytes = new Uint8Array(payload);
    } else {
        throw new Error('不支持的资源载荷类型');
    }

    if (bytes.length === 0) {
        throw new Error('获取到的资源内容为空 (0 字节)');
    }

    const baseName = stripExtension(fileName);

    // Case 1: PNG 角色卡
    if (isPngBytes(bytes)) {
        const parsedPng = await parsePngCharacterCard(bytes);
        const canonicalJson = canonicalStringify(parsedPng.normalized.v2Object);
        const hash = await sha256Hex(canonicalJson);
        return {
            type: 'character',
            format: 'png',
            sourceUrl,
            fileName: fileName || `${parsedPng.normalized.name}.png`,
            name: parsedPng.normalized.name,
            version: parsedPng.normalized.version,
            creator: parsedPng.normalized.creator,
            hash,
            byteLength: bytes.length,
            pngBytes: bytes,
            normalized: parsedPng.normalized,
            rawJson: parsedPng.rawJson,
            summary: {
                greetingCount: parsedPng.normalized.greetingCount,
                hasCharacterBook: parsedPng.normalized.hasCharacterBook,
                characterBookName: parsedPng.normalized.character_book?.name || '',
                regexCount: parsedPng.normalized.regexCount,
                helperScriptCount: parsedPng.normalized.helperScriptCount,
                tags: parsedPng.normalized.tags,
            },
        };
    }

    // Case 2: JSON (角色卡 / 预设 / 世界书)
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '').trim();
    let json;
    try {
        json = JSON.parse(text);
    } catch (err) {
        if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
            throw new Error('该链接返回的是 HTML 网页而非原始文件，请确认链接指向 Raw JSON 或 PNG 文件');
        }
        throw new Error(`解析 JSON 失败: ${err.message}`);
    }

    const type = classifyJsonResource(json);

    if (type === 'character') {
        const normalized = normalizeCharacterPayload(json);
        const canonicalJson = canonicalStringify(normalized.v2Object);
        const hash = await sha256Hex(canonicalJson);
        return {
            type: 'character',
            format: 'json',
            sourceUrl,
            fileName: fileName || `${normalized.name}.json`,
            name: normalized.name,
            version: normalized.version,
            creator: normalized.creator,
            hash,
            byteLength: bytes.length,
            pngBytes: null,
            normalized,
            rawJson: json,
            summary: {
                greetingCount: normalized.greetingCount,
                hasCharacterBook: normalized.hasCharacterBook,
                characterBookName: normalized.character_book?.name || '',
                regexCount: normalized.regexCount,
                helperScriptCount: normalized.helperScriptCount,
                tags: normalized.tags,
            },
        };
    }

    if (type === 'worldbook') {
        const normalized = normalizeWorldbookPayload(json);
        const inferredName = normalized.name || baseName || '未命名世界书';
        const canonicalJson = canonicalStringify(normalized.bookData);
        const hash = await sha256Hex(canonicalJson);
        return {
            type: 'worldbook',
            format: 'json',
            sourceUrl,
            fileName: fileName || `${inferredName}.json`,
            name: inferredName,
            version: String(json.version || ''),
            creator: String(json.creator || ''),
            hash,
            byteLength: bytes.length,
            normalized,
            rawJson: json,
            summary: {
                entryCount: normalized.entryCount,
                enabledEntryCount: Object.values(normalized.entries).filter(e => !e.disable).length,
            },
        };
    }

    // type === 'preset'
    const normalized = inspectPresetPayload(json, baseName || '未命名预设');
    const canonicalJson = canonicalStringify(normalized.rawPreset);
    const hash = await sha256Hex(canonicalJson);
    return {
        type: 'preset',
        format: 'json',
        sourceUrl,
        fileName: fileName || `${normalized.name || 'preset'}.json`,
        name: normalized.name || baseName || '未命名预设',
        version: normalized.version,
        creator: String(json.creator || ''),
        hash,
        byteLength: bytes.length,
        normalized,
        rawJson: json,
        summary: {
            promptCount: normalized.promptCount,
            enabledPromptCount: normalized.enabledPromptCount,
            regexCount: normalized.regexCount,
            helperScriptCount: normalized.helperScriptCount,
            temperature: normalized.temperature,
            maxContext: normalized.maxContext,
            maxTokens: normalized.maxTokens,
        },
    };
}

/**
 * 从 URL 拉取并自动识别资源内容
 * @param {string} rawUrl
 * @param {Object} [options]
 * @param {string} [options.githubMirrorPrefix='']
 * @param {Function} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 */
export async function fetchAndInspectUrl(rawUrl, {
    githubMirrorPrefix = '',
    fetchImpl = globalThis.fetch,
    signal = null,
} = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('当前环境缺少 fetch 网络请求支持');
    }

    const urlInfo = normalizeResourceUrl(rawUrl, { githubMirrorPrefix });
    let response;
    try {
        response = await fetchImpl(urlInfo.resolvedUrl, {
            method: 'GET',
            cache: 'no-store',
            signal,
        });
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error('请求已取消');
        }
        throw new Error(`拉取链接失败（可能受跨域 CORS 或网络阻断影响）: ${err.message}`);
    }

    if (!response.ok) {
        throw new Error(`远端服务器返回错误: HTTP ${response.status} ${response.statusText || ''}`.trim());
    }

    const ab = await response.arrayBuffer();
    const inspection = await inspectResourceBytes(new Uint8Array(ab), {
        fileName: urlInfo.suggestedFilename,
        sourceUrl: urlInfo.originalUrl,
    });

    return {
        ...inspection,
        urlInfo,
    };
}
