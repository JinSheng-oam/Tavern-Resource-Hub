/**
 * Tavern-Resource-Hub: Dual-Host (SillyTavern & TauriTavern) + Tavern Helper Adapter
 * 封装角色卡、预设、世界书的枚举、读取、原地保存与绑定操作。
 */

import {
    encodePngCharacterCard,
    normalizeCharacterPayload,
    normalizeWorldbookPayload,
    inspectPresetPayload,
    MINIMAL_1X1_PNG,
} from './card-codec.js';

export class PlatformAdapter {
    /**
     * 探测当前运行宿主环境与酒馆助手 (Tavern Helper / JS-Slash-Runner) 状态
     */
    static detectEnvironment(context = globalThis.SillyTavern?.getContext?.()) {
        const isTauri = typeof window !== 'undefined' && Boolean(
            window.__TAURITAVERN__ ||
            window.__TAURITAVERN_HOST__ ||
            window.__TAURI_RUNNING__ ||
            window.__TAURI__
        );
        const host = isTauri
            ? 'TauriTavern'
            : (context || typeof globalThis.SillyTavern !== 'undefined' ? 'SillyTavern' : 'MockHost');

        const helper = (typeof globalThis !== 'undefined' && globalThis.TavernHelper) ? globalThis.TavernHelper : null;
        let helperVersion = null;
        if (helper && typeof helper.getTavernHelperVersion === 'function') {
            try {
                helperVersion = String(helper.getTavernHelperVersion() || '');
            } catch {
                helperVersion = 'detected';
            }
        } else if (helper) {
            helperVersion = 'detected';
        }

        return {
            host,
            isTauri,
            hasTavernHelper: Boolean(helper),
            tavernHelperVersion: helperVersion,
            helper,
        };
    }

    static getHeaders(context) {
        return context?.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
    }

    // =========================================================================
    // 1. 角色卡 (Character Cards)
    // =========================================================================

    /**
     * 获取角色卡绑定的主世界书与附加世界书
     */
    static getCharacterWorldbookBindings(context, charObj) {
        const avatarId = charObj?.avatar || '';
        const primaryFromCard = String(charObj?.data?.extensions?.world || charObj?.world || '').trim() || null;

        const helper = globalThis.TavernHelper;
        if (helper && typeof helper.getCharWorldbookNames === 'function' && avatarId) {
            try {
                const res = helper.getCharWorldbookNames(avatarId);
                if (res && typeof res === 'object') {
                    return {
                        primary: res.primary || primaryFromCard || null,
                        additional: Array.isArray(res.additional) ? [...res.additional] : [],
                    };
                }
            } catch {
                // Fallback to native context
            }
        }

        const charLoreList =
            context?.worldInfoSettings?.char_lore ||
            context?.powerUserSettings?.world_info?.char_lore ||
            context?.extensionSettings?.world_info?.char_lore ||
            [];
        const cleanAvatarName = avatarId.replace(/\.png$/i, '');
        const matchedEntry = Array.isArray(charLoreList)
            ? charLoreList.find(item => item && (item.name === avatarId || item.name === cleanAvatarName))
            : null;
        const additional = Array.isArray(matchedEntry?.extraBooks) ? [...matchedEntry.extraBooks] : [];

        return {
            primary: primaryFromCard,
            additional,
        };
    }

    /**
     * 列出宿主中的所有角色卡摘要信息
     */
    static async listCharacters(context, { unshallowAll = false } = {}) {
        if (!context || !Array.isArray(context.characters)) return [];
        const activeChar = context.characters?.[context.characterId];
        const activeAvatar = activeChar?.avatar || null;

        const results = [];
        for (let i = 0; i < context.characters.length; i++) {
            let char = context.characters[i];
            if (!char || (!char.name && !char.avatar)) continue;

            if (unshallowAll && char.shallow && typeof context.unshallowCharacter === 'function') {
                try {
                    await context.unshallowCharacter(String(i));
                    char = context.characters[i] || char;
                } catch {
                    // Keep shallow data if unshallow fails
                }
            }

            const avatarId = String(char.avatar || `${char.name}.png`);
            const d = (char.data && typeof char.data === 'object') ? char.data : {};
            const ext = (d.extensions && typeof d.extensions === 'object') ? d.extensions : {};
            const wbBindings = PlatformAdapter.getCharacterWorldbookBindings(context, char);
            const regexScripts = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
            const helperScripts = Array.isArray(ext.tavern_helper?.scripts) ? ext.tavern_helper.scripts : [];
            const altGreetings = Array.isArray(d.alternate_greetings)
                ? d.alternate_greetings
                : (Array.isArray(char.alternate_greetings) ? char.alternate_greetings : []);

            const avatarUrl = typeof context.getThumbnailUrl === 'function'
                ? context.getThumbnailUrl('avatar', avatarId)
                : `/characters/${encodeURIComponent(avatarId)}`;

            results.push({
                chid: i,
                id: avatarId,
                avatar: avatarId,
                avatarUrl,
                name: String(char.name || d.name || avatarId.replace(/\.png$/i, '')),
                version: String(d.character_version || char.character_version || ''),
                creator: String(d.creator || char.creator || ''),
                description: String(char.description ?? d.description ?? ''),
                firstMessage: String(char.first_mes ?? d.first_mes ?? ''),
                greetingCount: 1 + altGreetings.length,
                fav: Boolean(char.fav || ext.fav),
                isCurrent: activeAvatar === avatarId || String(context.characterId) === String(i),
                chat: String(char.chat || ''),
                tags: Array.isArray(char.tags) ? char.tags : (Array.isArray(d.tags) ? d.tags : []),
                worldbookPrimary: wbBindings.primary,
                worldbookAdditional: wbBindings.additional,
                hasEmbeddedBook: Boolean(d.character_book && Object.keys(d.character_book.entries || {}).length > 0),
                embeddedBookName: String(d.character_book?.name || ''),
                regexCount: regexScripts.length,
                helperScriptCount: helperScripts.length,
                shallow: Boolean(char.shallow),
            });
        }

        return results;
    }

    /**
     * 根据 avatarId（或角色名）查找并读取完整角色卡对象（自动执行 unshallow）
     */
    static async getCharacterFullData(context, avatarOrName) {
        if (!context || !Array.isArray(context.characters)) {
            throw new Error('宿主角色列表未就绪');
        }

        let chid = context.characters.findIndex(c => c && c.avatar === avatarOrName);
        if (chid === -1) {
            chid = context.characters.findIndex(c => c && c.name === avatarOrName);
        }
        if (chid === -1) {
            throw new Error(`未找到目标角色卡: ${avatarOrName}`);
        }

        if (context.characters[chid]?.shallow && typeof context.unshallowCharacter === 'function') {
            await context.unshallowCharacter(String(chid));
        }

        const charObj = context.characters[chid];
        const worldbooks = PlatformAdapter.getCharacterWorldbookBindings(context, charObj);
        return {
            chid,
            avatarId: charObj.avatar,
            charObj: structuredClone(charObj),
            worldbooks,
        };
    }

    /**
     * 原地保存角色卡数据（保持 avatar 文件名与聊天记录不变）
     * @param {Object} context
     * @param {string} avatarId
     * @param {Object} mergedV2Card 合并后的完整 V2/V3 角色卡对象
     * @param {Object} [options]
     * @param {Uint8Array|null} [options.pngBytes=null] 如果远端提供的是新 PNG 图片，则携带其字节流
     * @param {Function} [options.fetchImpl]
     */
    static async saveCharacterInPlace(context, avatarId, mergedV2Card, {
        pngBytes = null,
        fetchImpl = globalThis.fetch,
    } = {}) {
        const { chid, charObj } = await PlatformAdapter.getCharacterFullData(context, avatarId);
        const normalized = normalizeCharacterPayload(mergedV2Card);
        const v2 = normalized.v2Object;

        // 锁定身份字段：avatar 与 chat 与 create_date 绝不改变
        v2.avatar = avatarId;
        v2.chat = charObj.chat || v2.chat || '';
        if (charObj.create_date) {
            v2.create_date = charObj.create_date;
        }

        let persistedViaApi = false;
        const headers = PlatformAdapter.getHeaders(context);

        if (typeof fetchImpl === 'function') {
            // 优先通过 /api/characters/edit (FormData) 或 /api/characters/merge-attributes 落盘
            let targetPngBytes = pngBytes;
            if (!targetPngBytes) {
                try {
                    const imgRes = await fetchImpl(`/characters/${encodeURIComponent(avatarId)}`, { method: 'GET' });
                    if (imgRes.ok) {
                        targetPngBytes = new Uint8Array(await imgRes.arrayBuffer());
                    }
                } catch {
                    // Fallback to merge-attributes or minimal PNG
                }
            }

            if (typeof FormData === 'function' && typeof Blob === 'function') {
                try {
                    const formData = new FormData();
                    formData.append('avatar_url', avatarId);
                    formData.append('ch_name', v2.name);
                    formData.append('description', v2.description);
                    formData.append('personality', v2.personality);
                    formData.append('first_mes', v2.first_mes);
                    formData.append('scenario', v2.scenario);
                    formData.append('mes_example', v2.mes_example);
                    formData.append('creator_notes', v2.data.creator_notes);
                    formData.append('system_prompt', v2.data.system_prompt);
                    formData.append('post_history_instructions', v2.data.post_history_instructions);
                    formData.append('creator', v2.data.creator);
                    formData.append('character_version', v2.data.character_version);
                    formData.append('talkativeness', String(v2.talkativeness));
                    formData.append('fav', String(v2.fav));
                    formData.append('tags', JSON.stringify(v2.tags));
                    formData.append('alternate_greetings', JSON.stringify(v2.data.alternate_greetings));
                    formData.append('extensions', JSON.stringify(v2.data.extensions));
                    formData.append('chat', v2.chat);
                    if (v2.create_date) formData.append('create_date', v2.create_date);
                    formData.append('json_data', JSON.stringify(v2));

                    if (targetPngBytes) {
                        const encodedPng = encodePngCharacterCard(targetPngBytes, v2);
                        formData.append('avatar', new Blob([encodedPng], { type: 'image/png' }), avatarId);
                    }

                    const editHeaders = { ...headers };
                    delete editHeaders['Content-Type'];
                    delete editHeaders['content-type'];

                    const editRes = await fetchImpl('/api/characters/edit', {
                        method: 'POST',
                        headers: editHeaders,
                        body: formData,
                    });
                    if (editRes.ok) {
                        persistedViaApi = true;
                    }
                } catch {
                    // Try merge-attributes next
                }
            }

            if (!persistedViaApi) {
                try {
                    const mergeRes = await fetchImpl('/api/characters/merge-attributes', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            avatar: avatarId,
                            ...v2,
                        }),
                    });
                    if (mergeRes.ok) {
                        persistedViaApi = true;
                    }
                } catch {
                    // Fall through
                }
            }
        }

        // 同步更新宿主内存中的 context.characters[chid]
        const updatedInMemory = {
            ...charObj,
            ...v2,
            avatar: avatarId,
            chat: v2.chat,
            shallow: false,
            json_data: JSON.stringify(v2),
            data: structuredClone(v2.data),
        };
        context.characters[chid] = updatedInMemory;

        if (typeof context.getCharacters === 'function' && persistedViaApi) {
            try {
                await context.getCharacters();
            } catch {
                // Keep memory update
            }
        }

        return {
            ok: true,
            chid,
            avatarId,
            persistedViaApi,
            character: updatedInMemory,
        };
    }

    /**
     * 导入全新角色卡到宿主
     */
    static async importNewCharacterToHost(context, remoteInspection, { fetchImpl = globalThis.fetch } = {}) {
        const helper = globalThis.TavernHelper;
        const v2 = remoteInspection.normalized.v2Object;
        const pngBytes = remoteInspection.pngBytes
            ? encodePngCharacterCard(remoteInspection.pngBytes, v2)
            : encodePngCharacterCard(MINIMAL_1X1_PNG, v2);

        if (helper && typeof helper.importRawCharacter === 'function' && typeof Blob === 'function') {
            const res = await helper.importRawCharacter(
                `${v2.name}.png`,
                new Blob([pngBytes], { type: 'image/png' })
            );
            if (res && res.ok !== false) {
                await context?.getCharacters?.();
                const created = context?.characters?.findLast?.(c => c?.name === v2.name) ||
                    context?.characters?.find?.(c => c?.name === v2.name);
                return {
                    ok: true,
                    avatarId: created?.avatar || `${v2.name}.png`,
                    name: v2.name,
                };
            }
        }

        if (typeof fetchImpl === 'function' && typeof FormData === 'function' && typeof Blob === 'function') {
            const headers = { ...PlatformAdapter.getHeaders(context) };
            delete headers['Content-Type'];
            delete headers['content-type'];

            const formData = new FormData();
            formData.append('avatar', new Blob([pngBytes], { type: 'image/png' }), `${v2.name}.png`);
            formData.append('file_type', 'png');

            const res = await fetchImpl('/api/characters/import', {
                method: 'POST',
                headers,
                body: formData,
            });
            if (!res.ok) {
                throw new Error(`导入新角色卡失败: HTTP ${res.status}`);
            }
            let data = {};
            try {
                data = await res.json();
            } catch {
                // Ignore non-JSON response
            }
            await context?.getCharacters?.();
            const avatarId = data.file_name
                ? (String(data.file_name).endsWith('.png') ? data.file_name : `${data.file_name}.png`)
                : (context?.characters?.find?.(c => c?.name === v2.name)?.avatar || `${v2.name}.png`);
            return {
                ok: true,
                avatarId,
                name: v2.name,
            };
        }

        // Mock / 离线测试环境回退：直接推入 context.characters
        if (context && Array.isArray(context.characters)) {
            const existingIds = new Set(context.characters.map(c => c?.avatar));
            let avatarId = `${v2.name}.png`;
            let suffix = 1;
            while (existingIds.has(avatarId)) {
                avatarId = `${v2.name}_${suffix++}.png`;
            }
            const newChar = {
                ...structuredClone(v2),
                avatar: avatarId,
                chat: `${v2.name} - default`,
                shallow: false,
            };
            context.characters.push(newChar);
            return {
                ok: true,
                avatarId,
                name: v2.name,
            };
        }

        throw new Error('当前环境不支持导入新角色卡');
    }

    // =========================================================================
    // 2. 预设 (Chat Completion Presets)
    // =========================================================================

    /**
     * 获取宿主中的预设字典与当前活跃预设名称
     */
    static async listPresets(context, { fetchImpl = globalThis.fetch } = {}) {
        const presetMap = new Map();
        let activePresetName = String(
            context?.chatCompletionSettings?.preset_settings_openai ||
            globalThis.oai_settings?.preset_settings_openai ||
            ''
        ).trim();

        const helper = globalThis.TavernHelper;
        if (!activePresetName && helper && typeof helper.getLoadedPresetName === 'function') {
            try {
                activePresetName = String(helper.getLoadedPresetName() || '').trim();
            } catch {
                // Ignore
            }
        }

        // 来源 A: context.getPresetManager('openai')
        const pm = context?.getPresetManager?.('openai');
        if (pm) {
            try {
                if (!activePresetName && typeof pm.getSelectedPresetName === 'function') {
                    activePresetName = String(pm.getSelectedPresetName() || '').trim();
                }
                const list = typeof pm.getPresetList === 'function' ? pm.getPresetList() : null;
                const presetsObj = list?.presets || pm.presets;
                const namesObj = list?.preset_names || pm.preset_names;
                if (Array.isArray(presetsObj) && namesObj && typeof namesObj === 'object') {
                    for (const [name, idx] of Object.entries(namesObj)) {
                        if (presetsObj[idx] && typeof presetsObj[idx] === 'object') {
                            presetMap.set(name, structuredClone(presetsObj[idx]));
                        }
                    }
                } else if (presetsObj && typeof presetsObj === 'object' && !Array.isArray(presetsObj)) {
                    for (const [name, data] of Object.entries(presetsObj)) {
                        if (data && typeof data === 'object') {
                            presetMap.set(name, structuredClone(data));
                        }
                    }
                }
            } catch {
                // Fall through
            }
        }

        // 来源 B: globalThis.openai_settings & openai_setting_names (模拟宿主或全局暴露)
        if (presetMap.size === 0 && globalThis.openai_setting_names && globalThis.openai_settings) {
            const namesObj = globalThis.openai_setting_names;
            const arr = globalThis.openai_settings;
            for (const [name, idx] of Object.entries(namesObj)) {
                if (arr[idx] && typeof arr[idx] === 'object') {
                    presetMap.set(name, structuredClone(arr[idx]));
                }
            }
        }

        // 来源 C: context.presets (测试夹具简写)
        if (presetMap.size === 0 && context?.presets && typeof context.presets === 'object') {
            for (const [name, data] of Object.entries(context.presets)) {
                if (data && typeof data === 'object') {
                    presetMap.set(name, structuredClone(data));
                }
            }
        }

        // 来源 D: /api/presets/list + /api/presets/get
        if (presetMap.size === 0 && typeof fetchImpl === 'function') {
            try {
                const headers = PlatformAdapter.getHeaders(context);
                const listRes = await fetchImpl('/api/presets/list', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ source: 'openai' }),
                });
                if (listRes.ok) {
                    const listData = await listRes.json();
                    const names = Array.isArray(listData) ? listData : Object.keys(listData || {});
                    for (const name of names) {
                        const getRes = await fetchImpl('/api/presets/get', {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({ preset: name, source: 'openai' }),
                        });
                        if (getRes.ok) {
                            const pData = await getRes.json();
                            if (pData && typeof pData === 'object') {
                                presetMap.set(name, pData);
                            }
                        }
                    }
                }
            } catch {
                // Fall through
            }
        }

        // 来源 E: TavernHelper.getPresetNames()
        if (presetMap.size === 0 && helper && typeof helper.getPresetNames === 'function') {
            try {
                const names = helper.getPresetNames();
                if (Array.isArray(names)) {
                    for (const name of names) {
                        try {
                            const p = helper.getPreset(name);
                            if (p && typeof p === 'object') {
                                presetMap.set(name, structuredClone(p));
                            }
                        } catch {
                            presetMap.set(name, {});
                        }
                    }
                }
            } catch {
                // Ignore
            }
        }

        const results = [];
        for (const [name, data] of presetMap.entries()) {
            const inspected = inspectPresetPayload(data, name);
            results.push({
                id: name,
                name,
                isCurrent: name === activePresetName,
                version: inspected.version,
                promptCount: inspected.promptCount,
                enabledPromptCount: inspected.enabledPromptCount,
                regexCount: inspected.regexCount,
                helperScriptCount: inspected.helperScriptCount,
                temperature: inspected.temperature,
                maxContext: inspected.maxContext,
                maxTokens: inspected.maxTokens,
                data,
            });
        }

        return results;
    }

    /**
     * 获取单个预设的完整 JSON 数据
     */
    static async getPresetFullData(context, presetName, { fetchImpl = globalThis.fetch } = {}) {
        const list = await PlatformAdapter.listPresets(context, { fetchImpl });
        const found = list.find(item => item.name === presetName);
        if (!found) {
            throw new Error(`未找到预设: ${presetName}`);
        }
        return structuredClone(found.data);
    }

    /**
     * 原地保存或新建预设，并同步宿主内存状态
     */
    static async savePresetInPlace(context, presetName, presetData, {
        fetchImpl = globalThis.fetch,
    } = {}) {
        const cleanName = String(presetName || '').trim();
        if (!cleanName) throw new Error('预设名称不能为空');

        const cloned = structuredClone(presetData);
        let persistedViaApi = false;

        if (typeof fetchImpl === 'function') {
            try {
                const res = await fetchImpl('/api/presets/save', {
                    method: 'POST',
                    headers: PlatformAdapter.getHeaders(context),
                    body: JSON.stringify({
                        apiId: 'openai',
                        name: cleanName,
                        preset: cloned,
                    }),
                });
                if (res.ok) {
                    persistedViaApi = true;
                }
            } catch {
                // Fallback to memory / helper
            }
        }

        // 同步更新宿主内存中的预设表
        if (globalThis.openai_setting_names && Array.isArray(globalThis.openai_settings)) {
            if (Object.hasOwn(globalThis.openai_setting_names, cleanName)) {
                const idx = globalThis.openai_setting_names[cleanName];
                globalThis.openai_settings[idx] = structuredClone(cloned);
            } else {
                const idx = globalThis.openai_settings.push(structuredClone(cloned)) - 1;
                globalThis.openai_setting_names[cleanName] = idx;
            }
        }

        if (context?.presets && typeof context.presets === 'object') {
            context.presets[cleanName] = structuredClone(cloned);
        }

        const pm = context?.getPresetManager?.('openai');
        if (pm) {
            const list = typeof pm.getPresetList === 'function' ? pm.getPresetList() : null;
            const presetsObj = list?.presets || pm.presets;
            const namesObj = list?.preset_names || pm.preset_names;
            if (Array.isArray(presetsObj) && namesObj && typeof namesObj === 'object') {
                if (Object.hasOwn(namesObj, cleanName)) {
                    presetsObj[namesObj[cleanName]] = structuredClone(cloned);
                } else {
                    namesObj[cleanName] = presetsObj.push(structuredClone(cloned)) - 1;
                }
            } else if (presetsObj && typeof presetsObj === 'object' && !Array.isArray(presetsObj)) {
                presetsObj[cleanName] = structuredClone(cloned);
            }
        }

        // 若更新的是当前正在使用的预设，同步采样与提示词到活跃 oai_settings
        const activeSettings = context?.chatCompletionSettings || globalThis.oai_settings;
        if (activeSettings && activeSettings.preset_settings_openai === cleanName) {
            Object.assign(activeSettings, structuredClone(cloned), {
                preset_settings_openai: cleanName,
            });
        }

        return {
            ok: true,
            name: cleanName,
            persistedViaApi,
            preset: cloned,
        };
    }

    /**
     * 切换当前生效的预设
     */
    static async activatePreset(context, presetName) {
        const helper = globalThis.TavernHelper;
        if (helper && typeof helper.loadPreset === 'function') {
            try {
                const ok = helper.loadPreset(presetName);
                if (ok) return true;
            } catch {
                // Fall back to PresetManager
            }
        }

        const pm = context?.getPresetManager?.('openai');
        if (pm && typeof pm.selectPreset === 'function') {
            await pm.selectPreset(presetName);
            return true;
        }

        const activeSettings = context?.chatCompletionSettings || globalThis.oai_settings;
        if (activeSettings) {
            activeSettings.preset_settings_openai = presetName;
            return true;
        }
        return false;
    }

    // =========================================================================
    // 3. 世界书 (Worldbooks / Lorebooks)
    // =========================================================================

    /**
     * 获取当前全局启用的世界书名称数组
     */
    static getGlobalWorldbooks(context) {
        const helper = globalThis.TavernHelper;
        if (helper && typeof helper.getGlobalWorldbookNames === 'function') {
            try {
                const names = helper.getGlobalWorldbookNames();
                if (Array.isArray(names)) return [...names];
            } catch {
                // Fallback
            }
        }
        const selected =
            context?.worldInfoSettings?.globalSelect ||
            context?.settings?.world_info?.globalSelect ||
            globalThis.selected_world_info ||
            [];
        return Array.isArray(selected) ? [...selected] : [];
    }

    /**
     * 列出宿主中的所有世界书及其词条数量与绑定关系
     */
    static async listWorldbooks(context, { fetchImpl = globalThis.fetch } = {}) {
        const env = PlatformAdapter.detectEnvironment(context);
        const headers = PlatformAdapter.getHeaders(context);
        let worldNames = null;

        // 1. 优先从 context.worldbooks (测试夹具) 或 TavernHelper 读取名称列表
        if (context?.worldbooks && typeof context.worldbooks === 'object') {
            worldNames = Object.keys(context.worldbooks);
        } else if (env.helper && typeof env.helper.getWorldbookNames === 'function') {
            try {
                const names = env.helper.getWorldbookNames();
                if (Array.isArray(names)) worldNames = names;
            } catch {
                // Fall through
            }
        }

        // 2. TauriTavern 使用 /api/settings/get 中的 world_names
        if (!Array.isArray(worldNames) && env.isTauri && typeof fetchImpl === 'function') {
            try {
                const settingsRes = await fetchImpl('/api/settings/get', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({}),
                });
                if (settingsRes.ok) {
                    const settingsData = await settingsRes.json();
                    if (Array.isArray(settingsData?.world_names)) {
                        worldNames = settingsData.world_names;
                    }
                }
            } catch {
                // Fall through
            }
        }

        // 3. SillyTavern 使用 /api/worldinfo/list
        if (!Array.isArray(worldNames) && typeof fetchImpl === 'function') {
            try {
                const listRes = await fetchImpl('/api/worldinfo/list', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({}),
                });
                if (listRes.ok) {
                    const listData = await listRes.json();
                    const items = Array.isArray(listData) ? listData : listData?.world_names;
                    if (Array.isArray(items)) {
                        worldNames = items.map(item => typeof item === 'string' ? item : item?.file_id).filter(Boolean);
                    }
                }
            } catch {
                // Fall through
            }
        }

        if (!Array.isArray(worldNames)) {
            worldNames = [];
        }

        const globalActive = new Set(PlatformAdapter.getGlobalWorldbooks(context));
        const characters = await PlatformAdapter.listCharacters(context);
        const charBindingsByWorld = new Map();
        for (const c of characters) {
            const bound = new Set([c.worldbookPrimary, ...(c.worldbookAdditional || [])].filter(Boolean));
            for (const wb of bound) {
                if (!charBindingsByWorld.has(wb)) charBindingsByWorld.set(wb, []);
                charBindingsByWorld.get(wb).push({ avatar: c.avatar, name: c.name, isPrimary: c.worldbookPrimary === wb });
            }
        }

        const results = [];
        for (const name of worldNames) {
            if (typeof name !== 'string' || !name.trim()) continue;
            let bookData = { entries: {} };
            try {
                bookData = await PlatformAdapter.getWorldbookFullData(context, name, { fetchImpl });
            } catch {
                // Keep empty entries fallback if reading single book fails
            }
            const entriesObj = (bookData?.entries && typeof bookData.entries === 'object') ? bookData.entries : {};
            const entryList = Object.values(entriesObj);

            results.push({
                id: name,
                name,
                entryCount: entryList.length,
                enabledEntryCount: entryList.filter(e => e && !e.disable).length,
                isGlobalActive: globalActive.has(name),
                boundCharacters: charBindingsByWorld.get(name) || [],
                data: bookData,
            });
        }

        return results;
    }

    /**
     * 读取指定世界书的完整数据 (`{ entries: { ... } }`)
     */
    static async getWorldbookFullData(context, worldName, { fetchImpl = globalThis.fetch } = {}) {
        if (context?.worldbooks && context.worldbooks[worldName]) {
            return structuredClone(context.worldbooks[worldName]);
        }

        if (typeof context?.loadWorldInfo === 'function') {
            const loaded = await context.loadWorldInfo(worldName);
            if (loaded && typeof loaded.entries === 'object') {
                return structuredClone(loaded);
            }
        }

        if (typeof fetchImpl === 'function') {
            const res = await fetchImpl('/api/worldinfo/get', {
                method: 'POST',
                headers: PlatformAdapter.getHeaders(context),
                body: JSON.stringify({ name: worldName }),
            });
            if (!res.ok) {
                throw new Error(`读取世界书 [${worldName}] 失败: HTTP ${res.status}`);
            }
            const data = await res.json();
            return normalizeWorldbookPayload(data).bookData;
        }

        throw new Error(`无法读取世界书: ${worldName}`);
    }

    /**
     * 原地保存或新建世界书（保持所有全局与角色绑定关系不变）
     */
    static async saveWorldbookInPlace(context, worldName, rawBookData, {
        fetchImpl = globalThis.fetch,
    } = {}) {
        const cleanName = String(worldName || '').trim();
        if (!cleanName) throw new Error('世界书名称不能为空');

        const normalized = normalizeWorldbookPayload(rawBookData);
        const bookData = normalized.bookData;
        let persisted = false;

        if (typeof context?.saveWorldInfo === 'function') {
            await context.saveWorldInfo(cleanName, bookData, true);
            persisted = true;
        } else if (typeof fetchImpl === 'function') {
            const res = await fetchImpl('/api/worldinfo/edit', {
                method: 'POST',
                headers: PlatformAdapter.getHeaders(context),
                body: JSON.stringify({
                    name: cleanName,
                    data: bookData,
                }),
            });
            if (!res.ok) {
                throw new Error(`保存世界书 [${cleanName}] 失败: HTTP ${res.status}`);
            }
            persisted = true;
        }

        if (context?.worldbooks && typeof context.worldbooks === 'object') {
            context.worldbooks[cleanName] = structuredClone(bookData);
            persisted = true;
        }

        context?.reloadWorldInfoEditor?.(cleanName, true);
        await context?.updateWorldInfoList?.();

        return {
            ok: true,
            name: cleanName,
            persisted,
            entryCount: normalized.entryCount,
            bookData,
        };
    }

    /**
     * 切换世界书的全局启用状态
     */
    static async toggleGlobalWorldbook(context, worldName, enabled) {
        const current = new Set(PlatformAdapter.getGlobalWorldbooks(context));
        if (enabled) current.add(worldName);
        else current.delete(worldName);
        const nextList = [...current];

        const helper = globalThis.TavernHelper;
        if (helper && typeof helper.rebindGlobalWorldbooks === 'function') {
            await helper.rebindGlobalWorldbooks(nextList);
            return nextList;
        }

        if (context?.worldInfoSettings) {
            context.worldInfoSettings.globalSelect = nextList;
        }
        if (Array.isArray(globalThis.selected_world_info)) {
            globalThis.selected_world_info.splice(0, globalThis.selected_world_info.length, ...nextList);
        }
        context?.saveSettingsDebounced?.();
        return nextList;
    }

    /**
     * 为角色卡重新绑定主世界书和附加世界书
     */
    static async rebindCharacterWorldbooks(context, avatarId, { primary = null, additional = [] } = {}, {
        fetchImpl = globalThis.fetch,
    } = {}) {
        const helper = globalThis.TavernHelper;
        if (helper && typeof helper.rebindCharWorldbooks === 'function') {
            try {
                await helper.rebindCharWorldbooks(avatarId, {
                    primary: primary || null,
                    additional: Array.isArray(additional) ? additional : [],
                });
            } catch {
                // Also apply to native character object below
            }
        }

        const { charObj } = await PlatformAdapter.getCharacterFullData(context, avatarId);
        charObj.data = charObj.data || {};
        charObj.data.extensions = charObj.data.extensions || {};
        charObj.data.extensions.world = primary || '';
        charObj.world = primary || '';

        await PlatformAdapter.saveCharacterInPlace(context, avatarId, charObj, { fetchImpl });
        return {
            primary: primary || null,
            additional: Array.isArray(additional) ? additional : [],
        };
    }
}
