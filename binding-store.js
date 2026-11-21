/**
 * Tavern-Resource-Hub: Binding & Snapshot Store
 * 管理角色卡、预设、世界书的更新源链接绑定、内容哈希指纹、关联关系与原地更新回滚快照。
 */

export const EXTENSION_ID = 'tavernResourceHub';
export const LOCAL_STORAGE_KEY = 'tavern_resource_hub_state_v1';
export const SNAPSHOT_STORAGE_KEY = 'tavern_resource_hub_snapshots_v1';

export const DEFAULT_PRESERVE_OPTIONS = {
    character: {
        preserveWorldbookBinding: true,
        syncEmbeddedWorldbook: true,
        preserveFavorite: true,
        preserveHelperVariables: true,
        preserveFirstMessage: false,
        preserveRegexScripts: false,
    },
    preset: {
        protectConnectionFields: true,
        preservePromptToggles: false,
        preserveHelperVariables: true,
    },
    worldbook: {
        mergeKeepLocalOnlyEntries: false,
    },
};

export const DEFAULT_SETTINGS = {
    schemaVersion: 1,
    githubMirrorPrefix: '',
    preserveDefaults: structuredClone(DEFAULT_PRESERVE_OPTIONS),
    bindings: {
        character: {},
        preset: {},
        worldbook: {},
    },
};

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 稳定 JSON 序列化：对象键按字典序排列，确保相同语义结构生成一致的 SHA-256 指纹
 */
export function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(item => canonicalStringify(item)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
        const item = value[key];
        if (typeof item === 'undefined') continue;
        parts.push(`${JSON.stringify(key)}:${canonicalStringify(item)}`);
    }
    return `{${parts.join(',')}}`;
}

/**
 * 计算字符串或字节数组的 SHA-256 十六进制摘要（兼容浏览器 Web Crypto 与 Node.js）
 * @param {string|Uint8Array} input
 * @returns {Promise<string>}
 */
export async function sha256Hex(input) {
    const bytes = typeof input === 'string'
        ? new TextEncoder().encode(input)
        : (input instanceof Uint8Array ? input : new Uint8Array(input));

    if (typeof process !== 'undefined' && process.versions?.node) {
        try {
            const nodeCrypto = await import('node:crypto');
            return nodeCrypto.createHash('sha256').update(bytes).digest('hex').toLowerCase();
        } catch {
            // Fall through to Web Crypto
        }
    }

    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .toLowerCase();
    }

    throw new Error('当前运行环境缺少 SHA-256 哈希支持');
}

export class BindingStore {
    /**
     * @param {Object} [options]
     * @param {Function} [options.getContext] 获取 SillyTavern 上下文的函数
     * @param {Storage} [options.storage] 可选自定义 Storage（便于单元测试）
     */
    constructor({ getContext = () => globalThis.SillyTavern?.getContext?.(), storage = globalThis.localStorage } = {}) {
        this.getContext = getContext;
        this.storage = storage || null;
        this.state = structuredClone(DEFAULT_SETTINGS);
        this.snapshots = {
            character: {},
            preset: {},
            worldbook: {},
        };
        this.load();
    }

    _normalizeState(raw) {
        const base = structuredClone(DEFAULT_SETTINGS);
        if (!isPlainObject(raw)) return base;

        if (typeof raw.githubMirrorPrefix === 'string') {
            base.githubMirrorPrefix = raw.githubMirrorPrefix.trim();
        }

        if (isPlainObject(raw.preserveDefaults)) {
            for (const type of ['character', 'preset', 'worldbook']) {
                if (isPlainObject(raw.preserveDefaults[type])) {
                    for (const key of Object.keys(base.preserveDefaults[type])) {
                        if (typeof raw.preserveDefaults[type][key] === 'boolean') {
                            base.preserveDefaults[type][key] = raw.preserveDefaults[type][key];
                        }
                    }
                }
            }
        }

        if (isPlainObject(raw.bindings)) {
            for (const type of ['character', 'preset', 'worldbook']) {
                if (isPlainObject(raw.bindings[type])) {
                    for (const [id, entry] of Object.entries(raw.bindings[type])) {
                        if (!id || !isPlainObject(entry)) continue;
                        base.bindings[type][id] = {
                            sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl.trim() : '',
                            lastHash: typeof entry.lastHash === 'string' ? entry.lastHash : '',
                            remoteHash: typeof entry.remoteHash === 'string' ? entry.remoteHash : '',
                            lastVersion: typeof entry.lastVersion === 'string' ? entry.lastVersion : '',
                            remoteVersion: typeof entry.remoteVersion === 'string' ? entry.remoteVersion : '',
                            lastUpdatedAt: Number.isFinite(entry.lastUpdatedAt) ? entry.lastUpdatedAt : 0,
                            lastCheckedAt: Number.isFinite(entry.lastCheckedAt) ? entry.lastCheckedAt : 0,
                            hasUpdate: Boolean(entry.hasUpdate),
                            linkedPreset: typeof entry.linkedPreset === 'string' ? entry.linkedPreset : '',
                            linkedWorldbooks: Array.isArray(entry.linkedWorldbooks)
                                ? entry.linkedWorldbooks.filter(w => typeof w === 'string' && w.trim())
                                : [],
                            notes: typeof entry.notes === 'string' ? entry.notes : '',
                        };
                    }
                }
            }
        }
        return base;
    }

    load() {
        let loaded = null;
        try {
            const context = this.getContext?.();
            if (isPlainObject(context?.extensionSettings?.[EXTENSION_ID])) {
                loaded = context.extensionSettings[EXTENSION_ID];
            }
        } catch {
            // Ignore context read errors before initialization
        }

        if (!loaded && this.storage) {
            try {
                const rawText = this.storage.getItem(LOCAL_STORAGE_KEY);
                if (rawText) loaded = JSON.parse(rawText);
            } catch {
                // Ignore corrupted localStorage
            }
        }

        this.state = this._normalizeState(loaded);

        if (this.storage) {
            try {
                const rawSnap = this.storage.getItem(SNAPSHOT_STORAGE_KEY);
                if (rawSnap) {
                    const parsed = JSON.parse(rawSnap);
                    if (isPlainObject(parsed)) {
                        for (const type of ['character', 'preset', 'worldbook']) {
                            if (isPlainObject(parsed[type])) {
                                this.snapshots[type] = parsed[type];
                            }
                        }
                    }
                }
            } catch {
                // Keep in-memory snapshots
            }
        }
        return this.state;
    }

    save() {
        const clean = this._normalizeState(this.state);
        this.state = clean;

        if (this.storage) {
            try {
                this.storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(clean));
            } catch {
                // Ignore quota errors
            }
        }

        try {
            const context = this.getContext?.();
            if (isPlainObject(context?.extensionSettings)) {
                context.extensionSettings[EXTENSION_ID] = structuredClone(clean);
                context.saveSettingsDebounced?.();
            }
        } catch {
            // Ignore host save error
        }
    }

    _saveSnapshots() {
        if (!this.storage) return;
        try {
            this.storage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(this.snapshots));
        } catch {
            // If storage quota exceeded, keep in-memory snapshot for session rollback
        }
    }

    getBinding(type, id) {
        if (!['character', 'preset', 'worldbook'].includes(type) || !id) return null;
        return this.state.bindings[type][id] || null;
    }

    setBinding(type, id, patch = {}) {
        if (!['character', 'preset', 'worldbook'].includes(type) || !id) {
            throw new Error(`无效的资源绑定目标: ${type} / ${id}`);
        }
        const existing = this.state.bindings[type][id] || {
            sourceUrl: '',
            lastHash: '',
            remoteHash: '',
            lastVersion: '',
            remoteVersion: '',
            lastUpdatedAt: 0,
            lastCheckedAt: 0,
            hasUpdate: false,
            linkedPreset: '',
            linkedWorldbooks: [],
            notes: '',
        };
        const updated = {
            ...existing,
            ...patch,
        };
        if (typeof updated.sourceUrl === 'string') {
            updated.sourceUrl = updated.sourceUrl.trim();
        }
        this.state.bindings[type][id] = updated;
        this.save();
        return updated;
    }

    removeBinding(type, id) {
        if (!['character', 'preset', 'worldbook'].includes(type) || !id) return false;
        if (!this.state.bindings[type][id]) return false;
        delete this.state.bindings[type][id];
        this.save();
        return true;
    }

    listBoundResources(type = null) {
        const types = type ? [type] : ['character', 'preset', 'worldbook'];
        const results = [];
        for (const t of types) {
            const map = this.state.bindings[t] || {};
            for (const [id, entry] of Object.entries(map)) {
                if (entry?.sourceUrl) {
                    results.push({ type: t, id, ...entry });
                }
            }
        }
        return results;
    }

    findBindingByUrl(normalizedUrl, rawUrl = '') {
        const targets = new Set([normalizedUrl, rawUrl].map(u => String(u || '').trim()).filter(Boolean));
        if (!targets.size) return null;
        for (const type of ['character', 'preset', 'worldbook']) {
            for (const [id, entry] of Object.entries(this.state.bindings[type] || {})) {
                if (targets.has(entry.sourceUrl)) {
                    return { type, id, binding: entry };
                }
            }
        }
        return null;
    }

    getPreserveDefaults(type) {
        return structuredClone(this.state.preserveDefaults[type] || DEFAULT_PRESERVE_OPTIONS[type] || {});
    }

    setPreserveDefaults(type, options) {
        if (!this.state.preserveDefaults[type]) return;
        Object.assign(this.state.preserveDefaults[type], options);
        this.save();
    }

    setGithubMirrorPrefix(prefix) {
        this.state.githubMirrorPrefix = String(prefix || '').trim();
        this.save();
    }

    /**
     * 记录原地更新前的快照，支持一键回滚
     */
    saveSnapshot(type, id, payload, metadata = {}) {
        if (!['character', 'preset', 'worldbook'].includes(type) || !id) return;
        this.snapshots[type][id] = {
            savedAt: Date.now(),
            metadata: structuredClone(metadata),
            payload: structuredClone(payload),
        };
        this._saveSnapshots();
    }

    getSnapshot(type, id) {
        if (!['character', 'preset', 'worldbook'].includes(type) || !id) return null;
        return this.snapshots[type][id] || null;
    }

    clearSnapshot(type, id) {
        if (!['character', 'preset', 'worldbook'].includes(type) || !id) return;
        delete this.snapshots[type][id];
        this._saveSnapshots();
    }
}
