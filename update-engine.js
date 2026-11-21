/**
 * Tavern-Resource-Hub: In-Place Update Engine
 * 核心负责角色卡、预设、世界书的差异对比 (Diff Preview)、无损原地覆盖更新與快照一键回滚。
 */

import {
    normalizeCharacterPayload,
    normalizeWorldbookPayload,
    inspectPresetPayload,
} from './card-codec.js';
import { canonicalStringify, sha256Hex } from './binding-store.js';
import { PlatformAdapter } from './platform.js';

/**
 * 预设更新时默认受保护的本地 API 连接与路由字段（避免导入他人预设冲掉自己的 API 线路）
 */
export const PROTECTED_PRESET_CONNECTION_FIELDS = [
    'chat_completion_source',
    'custom_url',
    'custom_model',
    'custom_api_format',
    'reverse_proxy',
    'proxy_password',
    'claude_model',
    'google_model',
    'vertexai_model',
    'openrouter_model',
    'ai21_model',
    'mistralai_model',
    'cohere_model',
    'perplexity_model',
    'groq_model',
    'deepseek_model',
    'xai_model',
    'opencode_endpoint',
    'opencode_api_format',
    'opencode_model',
    'additional_parameters_by_source',
    'additional_parameters_migration_version',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'preset_settings_openai',
];

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 构建用于版本一致性的去噪对象（剔除本地运行时/保护字段，避免同版本误报有更新）
 */
function stripLocalCharacterNoise(v2Object) {
    const clean = structuredClone(v2Object);
    delete clean.avatar;
    delete clean.chat;
    delete clean.create_date;
    delete clean.fav;
    delete clean.world;
    if (isPlainObject(clean.data?.extensions)) {
        delete clean.data.extensions.fav;
        delete clean.data.extensions.world;
        if (isPlainObject(clean.data.extensions.tavern_helper)) {
            delete clean.data.extensions.tavern_helper.variables;
        }
    }
    return clean;
}

function stripProtectedPresetNoise(rawPreset) {
    const clean = structuredClone(rawPreset);
    for (const field of PROTECTED_PRESET_CONNECTION_FIELDS) {
        delete clean[field];
    }
    if (isPlainObject(clean.extensions?.tavern_helper)) {
        delete clean.extensions.tavern_helper.variables;
    }
    return clean;
}

export class UpdateEngine {
    /**
     * 生成更新前的本地 vs 远端差异预览报告
     */
    static async buildUpdatePreview({ type, localData, remoteInspection }) {
        if (!remoteInspection || remoteInspection.type !== type) {
            throw new Error(`资源类型不匹配: 期望 ${type}，实际为 ${remoteInspection?.type || 'unknown'}`);
        }

        if (type === 'character') {
            const localNorm = normalizeCharacterPayload(localData);
            const remoteNorm = remoteInspection.normalized;
            const localHash = await sha256Hex(canonicalStringify(stripLocalCharacterNoise(localNorm.v2Object)));
            const remoteHash = await sha256Hex(canonicalStringify(stripLocalCharacterNoise(remoteNorm.v2Object)));

            const changedFields = [];
            if (localNorm.version !== remoteNorm.version) changedFields.push(`版本号 (${localNorm.version || '无'} → ${remoteNorm.version || '无'})`);
            if (localNorm.description !== remoteNorm.description) changedFields.push('角色描述 (description)');
            if (localNorm.personality !== remoteNorm.personality) changedFields.push('性格特征 (personality)');
            if (localNorm.scenario !== remoteNorm.scenario) changedFields.push('场景设定 (scenario)');
            if (localNorm.first_mes !== remoteNorm.first_mes) changedFields.push('主开场白 (first_mes)');
            if (JSON.stringify(localNorm.alternate_greetings) !== JSON.stringify(remoteNorm.alternate_greetings)) {
                changedFields.push(`候选开场白 (${localNorm.alternate_greetings.length} → ${remoteNorm.alternate_greetings.length})`);
            }
            if (localNorm.system_prompt !== remoteNorm.system_prompt) changedFields.push('角色系统提示词 (system_prompt)');
            if (localNorm.post_history_instructions !== remoteNorm.post_history_instructions) {
                changedFields.push('历史后指令 (post_history_instructions)');
            }
            if (localNorm.mes_example !== remoteNorm.mes_example) changedFields.push('对话示例 (mes_example)');
            if (localNorm.creator_notes !== remoteNorm.creator_notes) changedFields.push('作者注释 (creator_notes)');
            if (JSON.stringify(localNorm.extensions.regex_scripts) !== JSON.stringify(remoteNorm.extensions.regex_scripts)) {
                changedFields.push(`局部正则脚本 (${localNorm.regexCount} → ${remoteNorm.regexCount})`);
            }
            if (JSON.stringify(localNorm.extensions.tavern_helper?.scripts) !== JSON.stringify(remoteNorm.extensions.tavern_helper?.scripts)) {
                changedFields.push(`酒馆助手脚本 (${localNorm.helperScriptCount} → ${remoteNorm.helperScriptCount})`);
            }
            if (JSON.stringify(localNorm.character_book) !== JSON.stringify(remoteNorm.character_book)) {
                changedFields.push('内置世界书 (character_book)');
            }

            return {
                type: 'character',
                isIdentical: localHash === remoteHash && changedFields.length === 0,
                localVersion: localNorm.version || '未标注',
                remoteVersion: remoteNorm.version || '未标注',
                localHash,
                remoteHash,
                changedFields,
                metrics: {
                    greetings: { from: localNorm.greetingCount, to: remoteNorm.greetingCount },
                    regexes: { from: localNorm.regexCount, to: remoteNorm.regexCount },
                    helperScripts: { from: localNorm.helperScriptCount, to: remoteNorm.helperScriptCount },
                    hasEmbeddedBook: remoteNorm.hasCharacterBook,
                    embeddedBookName: remoteNorm.character_book?.name || '',
                },
            };
        }

        if (type === 'preset') {
            const localInsp = inspectPresetPayload(localData);
            const remoteInsp = remoteInspection.normalized;
            const localHash = await sha256Hex(canonicalStringify(stripProtectedPresetNoise(localInsp.rawPreset)));
            const remoteHash = await sha256Hex(canonicalStringify(stripProtectedPresetNoise(remoteInsp.rawPreset)));

            const localPrompts = Array.isArray(localData.prompts) ? localData.prompts : [];
            const remotePrompts = Array.isArray(remoteInspection.rawJson.prompts) ? remoteInspection.rawJson.prompts : [];
            const localById = new Map(localPrompts.map(p => [p.identifier || p.id || p.name, p]));
            const remoteById = new Map(remotePrompts.map(p => [p.identifier || p.id || p.name, p]));

            let addedPrompts = 0;
            let modifiedPrompts = 0;
            let removedPrompts = 0;

            for (const [id, rp] of remoteById.entries()) {
                if (!localById.has(id)) {
                    addedPrompts++;
                } else if (canonicalStringify(localById.get(id)) !== canonicalStringify(rp)) {
                    modifiedPrompts++;
                }
            }
            for (const id of localById.keys()) {
                if (!remoteById.has(id)) removedPrompts++;
            }

            const changedFields = [];
            if (addedPrompts > 0) changedFields.push(`新增提示词条目 (${addedPrompts})`);
            if (modifiedPrompts > 0) changedFields.push(`修改提示词条目 (${modifiedPrompts})`);
            if (removedPrompts > 0) changedFields.push(`移除提示词条目 (${removedPrompts})`);
            if (localInsp.temperature !== remoteInsp.temperature) {
                changedFields.push(`温度 (${localInsp.temperature ?? '-'} → ${remoteInsp.temperature ?? '-'})`);
            }
            if (localInsp.maxContext !== remoteInsp.maxContext) {
                changedFields.push(`最大上下文 (${localInsp.maxContext ?? '-'} → ${remoteInsp.maxContext ?? '-'})`);
            }
            if (localInsp.regexCount !== remoteInsp.regexCount) {
                changedFields.push(`预设正则 (${localInsp.regexCount} → ${remoteInsp.regexCount})`);
            }
            if (localInsp.helperScriptCount !== remoteInsp.helperScriptCount) {
                changedFields.push(`酒馆助手脚本 (${localInsp.helperScriptCount} → ${remoteInsp.helperScriptCount})`);
            }

            return {
                type: 'preset',
                isIdentical: localHash === remoteHash && changedFields.length === 0,
                localVersion: localInsp.version || '未标注',
                remoteVersion: remoteInsp.version || '未标注',
                localHash,
                remoteHash,
                changedFields,
                metrics: {
                    prompts: { from: localInsp.promptCount, to: remoteInsp.promptCount },
                    addedPrompts,
                    modifiedPrompts,
                    removedPrompts,
                    regexes: { from: localInsp.regexCount, to: remoteInsp.regexCount },
                    helperScripts: { from: localInsp.helperScriptCount, to: remoteInsp.helperScriptCount },
                },
            };
        }

        // type === 'worldbook'
        const localNorm = normalizeWorldbookPayload(localData);
        const remoteNorm = remoteInspection.normalized;
        const localHash = await sha256Hex(canonicalStringify(localNorm.bookData));
        const remoteHash = remoteInspection.hash;

        const localEntries = Object.values(localNorm.entries);
        const remoteEntries = Object.values(remoteNorm.entries);
        const localByKey = new Map(localEntries.map(e => [`${e.uid}:${e.comment}`, e]));
        const remoteByKey = new Map(remoteEntries.map(e => [`${e.uid}:${e.comment}`, e]));

        let addedEntries = 0;
        let modifiedEntries = 0;
        let removedEntries = 0;

        for (const [k, re] of remoteByKey.entries()) {
            if (!localByKey.has(k)) addedEntries++;
            else if (localByKey.get(k).content !== re.content || JSON.stringify(localByKey.get(k).key) !== JSON.stringify(re.key)) {
                modifiedEntries++;
            }
        }
        for (const k of localByKey.keys()) {
            if (!remoteByKey.has(k)) removedEntries++;
        }

        const changedFields = [];
        if (addedEntries > 0) changedFields.push(`新增世界书词条 (${addedEntries})`);
        if (modifiedEntries > 0) changedFields.push(`修改世界书词条 (${modifiedEntries})`);
        if (removedEntries > 0) changedFields.push(`移除世界书词条 (${removedEntries})`);

        return {
            type: 'worldbook',
            isIdentical: localHash === remoteHash,
            localVersion: '本地',
            remoteVersion: remoteInspection.version || '最新',
            localHash,
            remoteHash,
            changedFields,
            metrics: {
                entries: { from: localNorm.entryCount, to: remoteNorm.entryCount },
                addedEntries,
                modifiedEntries,
                removedEntries,
            },
        };
    }

    /**
     * 原地无损更新角色卡（保留 avatar、聊天记录、本地世界书绑定及指定保护项）
     */
    static async updateCharacterInPlace({
        context,
        store,
        avatarId,
        remoteInspection,
        options = {},
        fetchImpl = globalThis.fetch,
    }) {
        if (!remoteInspection || remoteInspection.type !== 'character') {
            throw new Error('提供的远端资源不是有效的角色卡');
        }

        const preserve = {
            ...store.getPreserveDefaults('character'),
            ...options,
        };

        const { charObj: currentChar, worldbooks: currentWb } = await PlatformAdapter.getCharacterFullData(context, avatarId);
        const localNorm = normalizeCharacterPayload(currentChar);
        const remoteNorm = remoteInspection.normalized;

        // 1. 保存更新前快照，支持一键回滚
        store.saveSnapshot('character', avatarId, localNorm.v2Object, {
            name: localNorm.name,
            version: localNorm.version,
            worldbooks: currentWb,
        });

        // 2. 构建合并后的 V2 角色卡对象
        const merged = structuredClone(remoteNorm.v2Object);
        merged.avatar = avatarId;
        merged.chat = currentChar.chat || '';
        if (currentChar.create_date) {
            merged.create_date = currentChar.create_date;
        }

        // 保留收藏状态
        if (preserve.preserveFavorite) {
            merged.fav = Boolean(currentChar.fav || localNorm.extensions.fav);
            merged.data.extensions.fav = merged.fav;
        }

        // 保留本地开场白（当用户勾选时）
        if (preserve.preserveFirstMessage) {
            merged.first_mes = localNorm.first_mes;
            merged.data.first_mes = localNorm.first_mes;
            merged.data.alternate_greetings = structuredClone(localNorm.alternate_greetings);
        }

        // 保留本地局部正则（当用户勾选时）
        if (preserve.preserveRegexScripts) {
            merged.data.extensions.regex_scripts = structuredClone(localNorm.extensions.regex_scripts);
        }

        // 保留酒馆助手运行时变量 (extensions.tavern_helper.variables)，同时更新脚本树 (scripts)
        if (preserve.preserveHelperVariables && isPlainObject(localNorm.extensions.tavern_helper)) {
            const localHelper = localNorm.extensions.tavern_helper;
            const remoteHelper = isPlainObject(merged.data.extensions.tavern_helper)
                ? merged.data.extensions.tavern_helper
                : {};
            merged.data.extensions.tavern_helper = {
                ...remoteHelper,
                scripts: Array.isArray(remoteHelper.scripts)
                    ? remoteHelper.scripts
                    : (Array.isArray(localHelper.scripts) ? structuredClone(localHelper.scripts) : []),
                variables: isPlainObject(localHelper.variables)
                    ? structuredClone(localHelper.variables)
                    : (isPlainObject(remoteHelper.variables) ? remoteHelper.variables : {}),
            };
        }

        // 处理世界书绑定与内置世界书同步
        let syncedWorldbookName = null;
        const localPrimaryWb = currentWb.primary || localNorm.extensions.world || '';

        if (preserve.syncEmbeddedWorldbook && remoteNorm.hasCharacterBook && remoteNorm.character_book) {
            const targetWbName = localPrimaryWb || remoteNorm.character_book.name || `${merged.name}_World`;
            await PlatformAdapter.saveWorldbookInPlace(context, targetWbName, remoteNorm.character_book, { fetchImpl });
            syncedWorldbookName = targetWbName;
            merged.data.extensions.world = targetWbName;
            merged.world = targetWbName;
        } else if (preserve.preserveWorldbookBinding && localPrimaryWb) {
            merged.data.extensions.world = localPrimaryWb;
            merged.world = localPrimaryWb;
        }

        // 3. 原地写盘并更新宿主内存
        const saveRes = await PlatformAdapter.saveCharacterInPlace(context, avatarId, merged, {
            pngBytes: remoteInspection.pngBytes || null,
            fetchImpl,
        });

        // 4. 更新绑定记录
        const finalCanonical = canonicalStringify(normalizeCharacterPayload(merged).v2Object);
        const finalHash = await sha256Hex(finalCanonical);
        const binding = store.setBinding('character', avatarId, {
            sourceUrl: remoteInspection.sourceUrl || store.getBinding('character', avatarId)?.sourceUrl || '',
            lastHash: remoteInspection.hash || finalHash,
            remoteHash: remoteInspection.hash || finalHash,
            lastVersion: merged.data.character_version || '',
            remoteVersion: merged.data.character_version || '',
            lastUpdatedAt: Date.now(),
            lastCheckedAt: Date.now(),
            hasUpdate: false,
        });

        return {
            ok: true,
            type: 'character',
            id: avatarId,
            name: merged.name,
            version: merged.data.character_version || '',
            syncedWorldbookName,
            preservedChat: merged.chat,
            preservedWorldbook: merged.data.extensions.world || null,
            binding,
            saveResult: saveRes,
        };
    }

    /**
     * 原地无损更新预设（默认保护本地 API 连接地址/模型/来源，支持保留提示词开关与酒馆助手变量）
     */
    static async updatePresetInPlace({
        context,
        store,
        presetName,
        remoteInspection,
        options = {},
        fetchImpl = globalThis.fetch,
    }) {
        if (!remoteInspection || remoteInspection.type !== 'preset') {
            throw new Error('提供的远端资源不是有效的预设');
        }

        const preserve = {
            ...store.getPreserveDefaults('preset'),
            ...options,
        };

        let currentPreset = {};
        try {
            currentPreset = await PlatformAdapter.getPresetFullData(context, presetName, { fetchImpl });
        } catch {
            currentPreset = {};
        }

        if (Object.keys(currentPreset).length > 0) {
            store.saveSnapshot('preset', presetName, currentPreset, {
                name: presetName,
            });
        }

        const merged = structuredClone(remoteInspection.rawJson);

        // 1. 保护本地 API 连接与路由字段（优先从原预设取，其次从当前活跃 oai_settings 取）
        if (preserve.protectConnectionFields) {
            const activeOai = context?.chatCompletionSettings || globalThis.oai_settings || {};
            for (const field of PROTECTED_PRESET_CONNECTION_FIELDS) {
                if (Object.hasOwn(currentPreset, field)) {
                    merged[field] = structuredClone(currentPreset[field]);
                } else if (Object.hasOwn(activeOai, field)) {
                    merged[field] = structuredClone(activeOai[field]);
                } else {
                    delete merged[field];
                }
            }
        }

        // 2. 保留本地同名提示词条目的启用开关状态 (enabled)
        if (preserve.preservePromptToggles) {
            if (Array.isArray(currentPreset.prompts) && Array.isArray(merged.prompts)) {
                const localEnabledMap = new Map();
                for (const p of currentPreset.prompts) {
                    const key = p?.identifier || p?.id || p?.name;
                    if (key && typeof p.enabled === 'boolean') {
                        localEnabledMap.set(key, p.enabled);
                    }
                }
                for (const p of merged.prompts) {
                    const key = p?.identifier || p?.id || p?.name;
                    if (key && localEnabledMap.has(key)) {
                        p.enabled = localEnabledMap.get(key);
                    }
                }
            }

            if (Array.isArray(currentPreset.prompt_order) && Array.isArray(merged.prompt_order)) {
                const localOrderToggle = new Map();
                for (const group of currentPreset.prompt_order) {
                    if (!Array.isArray(group?.order)) continue;
                    for (const item of group.order) {
                        if (item?.identifier && typeof item.enabled === 'boolean') {
                            localOrderToggle.set(`${group.character_id}:${item.identifier}`, item.enabled);
                        }
                    }
                }
                for (const group of merged.prompt_order) {
                    if (!Array.isArray(group?.order)) continue;
                    for (const item of group.order) {
                        const k = `${group.character_id}:${item?.identifier}`;
                        if (localOrderToggle.has(k)) {
                            item.enabled = localOrderToggle.get(k);
                        }
                    }
                }
            }
        }

        // 3. 保留预设内酒馆助手运行时变量 (extensions.tavern_helper.variables)
        if (preserve.preserveHelperVariables && isPlainObject(currentPreset.extensions?.tavern_helper)) {
            const localHelper = currentPreset.extensions.tavern_helper;
            merged.extensions = isPlainObject(merged.extensions) ? merged.extensions : {};
            const remoteHelper = isPlainObject(merged.extensions.tavern_helper) ? merged.extensions.tavern_helper : {};
            merged.extensions.tavern_helper = {
                ...remoteHelper,
                scripts: Array.isArray(remoteHelper.scripts)
                    ? remoteHelper.scripts
                    : (Array.isArray(localHelper.scripts) ? structuredClone(localHelper.scripts) : []),
                variables: isPlainObject(localHelper.variables)
                    ? structuredClone(localHelper.variables)
                    : (isPlainObject(remoteHelper.variables) ? remoteHelper.variables : {}),
            };
        }

        const saveRes = await PlatformAdapter.savePresetInPlace(context, presetName, merged, { fetchImpl });

        const binding = store.setBinding('preset', presetName, {
            sourceUrl: remoteInspection.sourceUrl || store.getBinding('preset', presetName)?.sourceUrl || '',
            lastHash: remoteInspection.hash,
            remoteHash: remoteInspection.hash,
            lastVersion: remoteInspection.version || '',
            remoteVersion: remoteInspection.version || '',
            lastUpdatedAt: Date.now(),
            lastCheckedAt: Date.now(),
            hasUpdate: false,
        });

        return {
            ok: true,
            type: 'preset',
            id: presetName,
            name: presetName,
            version: remoteInspection.version || '',
            binding,
            saveResult: saveRes,
        };
    }

    /**
     * 原地无损更新世界书（保持全局与角色绑定关系不变，可选保留仅本地存在的词条）
     */
    static async updateWorldbookInPlace({
        context,
        store,
        worldName,
        remoteInspection,
        options = {},
        fetchImpl = globalThis.fetch,
    }) {
        if (!remoteInspection || remoteInspection.type !== 'worldbook') {
            throw new Error('提供的远端资源不是有效的世界书');
        }

        const preserve = {
            ...store.getPreserveDefaults('worldbook'),
            ...options,
        };

        let currentBook = null;
        try {
            currentBook = await PlatformAdapter.getWorldbookFullData(context, worldName, { fetchImpl });
        } catch {
            currentBook = null;
        }

        if (currentBook && currentBook.entries) {
            store.saveSnapshot('worldbook', worldName, currentBook, {
                name: worldName,
            });
        }

        const targetBookData = structuredClone(remoteInspection.normalized.bookData);

        if (preserve.mergeKeepLocalOnlyEntries && currentBook?.entries) {
            const remoteComments = new Set(
                Object.values(targetBookData.entries).map(e => `${e.comment}::${(e.key || []).join(',')}`)
            );
            let maxUid = Object.values(targetBookData.entries).reduce(
                (max, e) => Math.max(max, Number.isInteger(e.uid) ? e.uid : 0),
                -1
            );
            for (const localEntry of Object.values(currentBook.entries)) {
                const sig = `${localEntry.comment}::${(localEntry.key || []).join(',')}`;
                if (!remoteComments.has(sig)) {
                    maxUid += 1;
                    targetBookData.entries[String(maxUid)] = {
                        ...structuredClone(localEntry),
                        uid: maxUid,
                    };
                }
            }
        }

        const saveRes = await PlatformAdapter.saveWorldbookInPlace(context, worldName, targetBookData, { fetchImpl });

        const binding = store.setBinding('worldbook', worldName, {
            sourceUrl: remoteInspection.sourceUrl || store.getBinding('worldbook', worldName)?.sourceUrl || '',
            lastHash: remoteInspection.hash,
            remoteHash: remoteInspection.hash,
            lastUpdatedAt: Date.now(),
            lastCheckedAt: Date.now(),
            hasUpdate: false,
        });

        return {
            ok: true,
            type: 'worldbook',
            id: worldName,
            name: worldName,
            entryCount: saveRes.entryCount,
            binding,
            saveResult: saveRes,
        };
    }

    /**
     * 一键回滚资源到最近一次原地更新前的快照
     */
    static async rollbackResource({
        context,
        store,
        type,
        id,
        fetchImpl = globalThis.fetch,
    }) {
        const snap = store.getSnapshot(type, id);
        if (!snap || !snap.payload) {
            throw new Error(`未找到 [${id}] 的本地回滚快照`);
        }

        if (type === 'character') {
            await PlatformAdapter.saveCharacterInPlace(context, id, snap.payload, { fetchImpl });
        } else if (type === 'preset') {
            await PlatformAdapter.savePresetInPlace(context, id, snap.payload, { fetchImpl });
        } else if (type === 'worldbook') {
            await PlatformAdapter.saveWorldbookInPlace(context, id, snap.payload, { fetchImpl });
        } else {
            throw new Error(`不支持回滚的资源类型: ${type}`);
        }

        store.clearSnapshot(type, id);
        return {
            ok: true,
            type,
            id,
            restoredFrom: snap.savedAt,
        };
    }
}
