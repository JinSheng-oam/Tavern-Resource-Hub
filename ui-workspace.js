/**
 * Tavern-Resource-Hub: Modern Independent Full-Page Workspace UI
 * “典藏工坊 (Curator's Atelier)” 独立全屏界面：集成角色卡、预设、世界书浏览、链接绑定与原地无损更新。
 */

import { PlatformAdapter } from './platform.js';
import { normalizeResourceUrl, inspectResourceBytes, fetchAndInspectUrl } from './url-resolver.js';
import { UpdateEngine } from './update-engine.js';
import { normalizeCharacterPayload } from './card-codec.js';

const TYPE_LABELS = {
    character: '角色卡',
    preset: '预设',
    worldbook: '世界书',
};

const TYPE_ICONS = {
    character: 'fa-id-badge',
    preset: 'fa-sliders',
    worldbook: 'fa-book-atlas',
};

function createEl(tag, className = '', text = null) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== null && text !== undefined) el.textContent = String(text);
    return el;
}

function createIcon(faClass) {
    const i = document.createElement('i');
    i.className = `fa-solid ${faClass}`;
    i.setAttribute('aria-hidden', 'true');
    return i;
}

function formatTime(ts) {
    if (!ts) return '未更新';
    try {
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
        return '未知时间';
    }
}

export class ResourceHubWorkspace {
    /**
     * @param {Object} options
     * @param {Function} options.getContext
     * @param {import('./binding-store.js').BindingStore} options.store
     * @param {Function} [options.fetchImpl]
     * @param {Function} [options.onNotify]
     * @param {Function} [options.onStateChange]
     */
    constructor({
        getContext,
        store,
        fetchImpl = globalThis.fetch,
        onNotify = null,
        onStateChange = null,
    }) {
        this.getContext = getContext;
        this.store = store;
        this.fetchImpl = fetchImpl;
        this.onNotify = onNotify;
        this.onStateChange = onStateChange;

        this.root = null;
        this.isOpen = false;
        this.activeTab = 'character'; // 'character' | 'preset' | 'worldbook' | 'bound'
        this.activeFilter = 'all'; // 'all' | 'bound' | 'updates' | 'helper' | 'active'
        this.searchQuery = '';

        this.catalog = {
            character: [],
            preset: [],
            worldbook: [],
        };

        this.selected = null; // { type: 'character'|'preset'|'worldbook', id: string }
        this.stagedUpdate = null; // { inspection, targetType, targetId, mode: 'inplace'|'create', preview, options }
        this.isBusy = false;
        this.showSettingsPopover = false;
        this._keydownHandler = this._handleKeydown.bind(this);
    }

    notify(level, message) {
        if (typeof this.onNotify === 'function') {
            this.onNotify(level, message);
            return;
        }
        if (globalThis.toastr && typeof globalThis.toastr[level] === 'function') {
            globalThis.toastr[level](String(message));
        } else {
            console.log(`[ResourceHub] [${level}] ${message}`);
        }
    }

    _handleKeydown(e) {
        if (!this.isOpen) return;
        if (e.key === 'Escape') {
            if (this.showSettingsPopover) {
                this.showSettingsPopover = false;
                this.render();
                return;
            }
            this.close();
        }
    }

    async open(initialTab = null) {
        if (initialTab && ['character', 'preset', 'worldbook', 'bound'].includes(initialTab)) {
            this.activeTab = initialTab;
        }
        if (!this.root) {
            this.root = createEl('div', 'trh-overlay');
            this.root.id = 'tavern_resource_hub_overlay';
            this.root.setAttribute('role', 'dialog');
            this.root.setAttribute('aria-modal', 'true');
            this.root.setAttribute('aria-label', '预设、角色卡与世界书管理器');
        }
        if (!this.root.isConnected) {
            document.body.append(this.root);
        }
        this.isOpen = true;
        document.addEventListener('keydown', this._keydownHandler);
        await this.refreshCatalog();
    }

    close() {
        this.isOpen = false;
        this.showSettingsPopover = false;
        document.removeEventListener('keydown', this._keydownHandler);
        if (this.root?.isConnected) {
            this.root.remove();
        }
        this.onStateChange?.();
    }

    destroy() {
        this.close();
        this.root = null;
    }

    async refreshCatalog() {
        const context = this.getContext?.();
        try {
            const [characters, presets, worldbooks] = await Promise.all([
                PlatformAdapter.listCharacters(context),
                PlatformAdapter.listPresets(context, { fetchImpl: this.fetchImpl }),
                PlatformAdapter.listWorldbooks(context, { fetchImpl: this.fetchImpl }),
            ]);
            this.catalog.character = characters;
            this.catalog.preset = presets;
            this.catalog.worldbook = worldbooks;

            // 若尚未选中任何项，默认选中当前分类的第一项
            if (!this.selected && !this.stagedUpdate) {
                const list = this.catalog[this.activeTab === 'bound' ? 'character' : this.activeTab] || [];
                if (list.length > 0) {
                    this.selected = { type: this.activeTab === 'bound' ? 'character' : this.activeTab, id: list[0].id };
                }
            }
        } catch (err) {
            this.notify('error', `读取资源列表失败: ${err.message}`);
        }
        this.render();
        this.onStateChange?.();
    }

    getSummaryCounts() {
        const boundList = this.store.listBoundResources();
        const updateCount = boundList.filter(b => b.hasUpdate).length;
        return {
            characterCount: this.catalog.character.length,
            presetCount: this.catalog.preset.length,
            worldbookCount: this.catalog.worldbook.length,
            boundCount: boundList.length,
            updateCount,
        };
    }

    /**
     * 处理顶部或详情面板输入的链接：拉取、自动识别类型、匹配目标并进入原地更新预览
     */
    async probeUrlForUpdate(rawUrl, preferredTarget = null) {
        const cleanUrl = String(rawUrl || '').trim();
        if (!cleanUrl) {
            this.notify('warning', '请先输入资源链接 (支持 .png / .json / GitHub)');
            return;
        }

        this.isBusy = true;
        this.render();

        try {
            const inspection = await fetchAndInspectUrl(cleanUrl, {
                githubMirrorPrefix: this.store.state.githubMirrorPrefix,
                fetchImpl: this.fetchImpl,
            });
            await this._stageInspection(inspection, preferredTarget);
            this.notify('info', `已解析 ${TYPE_LABELS[inspection.type]}: ${inspection.name}`);
        } catch (err) {
            this.notify('error', err.message);
        } finally {
            this.isBusy = false;
            this.render();
        }
    }

    /**
     * 处理本地文件选择（作为无 CORS 链接或本地更新包的回退）
     */
    async probeLocalFile(file, preferredTarget = null) {
        if (!file) return;
        this.isBusy = true;
        this.render();
        try {
            const ab = await file.arrayBuffer();
            const inspection = await inspectResourceBytes(new Uint8Array(ab), {
                fileName: file.name,
                sourceUrl: preferredTarget?.sourceUrl || '',
            });
            await this._stageInspection(inspection, preferredTarget);
            this.notify('info', `已读取本地${TYPE_LABELS[inspection.type]}文件: ${inspection.name}`);
        } catch (err) {
            this.notify('error', `解析文件失败: ${err.message}`);
        } finally {
            this.isBusy = false;
            this.render();
        }
    }

    async _stageInspection(inspection, preferredTarget = null) {
        const type = inspection.type;
        const list = this.catalog[type] || [];

        // 1. 确定要原地更新的目标资源 ID
        let targetId = null;
        if (preferredTarget && preferredTarget.type === type && preferredTarget.id) {
            targetId = preferredTarget.id;
        } else if (inspection.sourceUrl) {
            const boundMatch = this.store.findBindingByUrl(
                inspection.urlInfo?.resolvedUrl || inspection.sourceUrl,
                inspection.sourceUrl
            );
            if (boundMatch && boundMatch.type === type && list.some(item => item.id === boundMatch.id)) {
                targetId = boundMatch.id;
            }
        }

        // 2. 按名称或文件名匹配现有同名资源
        if (!targetId) {
            const byExactId = list.find(item => item.id === inspection.name || item.id === `${inspection.name}.png`);
            const byName = list.find(item => item.name.toLowerCase() === inspection.name.toLowerCase());
            targetId = (byExactId || byName)?.id || null;
        }

        const mode = targetId ? 'inplace' : 'create';
        const preserveOptions = this.store.getPreserveDefaults(type);
        let preview = null;

        if (targetId) {
            preview = await this._computePreviewForTarget(type, targetId, inspection);
            this.selected = { type, id: targetId };
        }

        if (this.activeTab !== 'bound' && this.activeTab !== type) {
            this.activeTab = type;
        }

        this.stagedUpdate = {
            inspection,
            targetType: type,
            targetId: targetId || (list[0]?.id || ''),
            mode,
            preview,
            options: preserveOptions,
        };
    }

    async _computePreviewForTarget(type, targetId, inspection) {
        const context = this.getContext?.();
        try {
            let localData = null;
            if (type === 'character') {
                const full = await PlatformAdapter.getCharacterFullData(context, targetId);
                localData = full.charObj;
            } else if (type === 'preset') {
                localData = await PlatformAdapter.getPresetFullData(context, targetId, { fetchImpl: this.fetchImpl });
            } else if (type === 'worldbook') {
                localData = await PlatformAdapter.getWorldbookFullData(context, targetId, { fetchImpl: this.fetchImpl });
            }
            if (localData) {
                return await UpdateEngine.buildUpdatePreview({
                    type,
                    localData,
                    remoteInspection: inspection,
                });
            }
        } catch {
            // Return null if target does not exist yet
        }
        return null;
    }

    /**
     * 批量检查所有已绑定 URL 的资源是否有远端更新
     */
    async checkAllBoundUpdates() {
        const boundList = this.store.listBoundResources();
        if (boundList.length === 0) {
            this.notify('info', '当前还没有绑定更新链接的资源，请先在右侧为角色卡、预设或世界书绑定链接');
            return;
        }

        this.isBusy = true;
        this.render();

        let checked = 0;
        let foundUpdates = 0;
        let failed = 0;

        for (const item of boundList) {
            try {
                const inspection = await fetchAndInspectUrl(item.sourceUrl, {
                    githubMirrorPrefix: this.store.state.githubMirrorPrefix,
                    fetchImpl: this.fetchImpl,
                });
                checked++;
                const preview = await this._computePreviewForTarget(item.type, item.id, inspection);
                const hasUpdate = preview ? !preview.isIdentical : (item.lastHash !== inspection.hash);
                if (hasUpdate) foundUpdates++;

                this.store.setBinding(item.type, item.id, {
                    remoteHash: inspection.hash,
                    remoteVersion: inspection.version || '',
                    lastCheckedAt: Date.now(),
                    hasUpdate,
                });
            } catch {
                failed++;
            }
        }

        this.isBusy = false;
        this.render();
        this.onStateChange?.();

        if (foundUpdates > 0) {
            this.notify('success', `检查完成：发现 ${foundUpdates} 个资源有新版本可更新`);
        } else if (failed > 0) {
            this.notify('warning', `检查完成：${checked} 个已是最新，${failed} 个链接拉取失败`);
        } else {
            this.notify('info', `已检查 ${checked} 个绑定资源，全部为最新版本`);
        }
    }

    /**
     * 执行已暂存的原地更新或新资源导入
     */
    async executeStagedUpdate() {
        if (!this.stagedUpdate) return;
        const { inspection, targetType, targetId, mode, options } = this.stagedUpdate;
        const context = this.getContext?.();

        this.isBusy = true;
        this.render();

        try {
            if (targetType === 'character') {
                if (mode === 'inplace' && targetId) {
                    const res = await UpdateEngine.updateCharacterInPlace({
                        context,
                        store: this.store,
                        avatarId: targetId,
                        remoteInspection: inspection,
                        options,
                        fetchImpl: this.fetchImpl,
                    });
                    this.selected = { type: 'character', id: res.id };
                    const wbMsg = res.syncedWorldbookName ? `（已同步世界书: ${res.syncedWorldbookName}）` : '';
                    this.notify('success', `角色卡 [${res.name}] 已原地更新，聊天记录与绑定已保留${wbMsg}`);
                } else {
                    const imported = await PlatformAdapter.importNewCharacterToHost(context, inspection, {
                        fetchImpl: this.fetchImpl,
                    });
                    if (inspection.sourceUrl) {
                        this.store.setBinding('character', imported.avatarId, {
                            sourceUrl: inspection.sourceUrl,
                            lastHash: inspection.hash,
                            remoteHash: inspection.hash,
                            lastVersion: inspection.version || '',
                            remoteVersion: inspection.version || '',
                            lastUpdatedAt: Date.now(),
                            hasUpdate: false,
                        });
                    }
                    this.selected = { type: 'character', id: imported.avatarId };
                    this.notify('success', `已导入新角色卡: ${imported.name}`);
                }
            } else if (targetType === 'preset') {
                const finalName = mode === 'inplace' && targetId ? targetId : (inspection.name || '导入预设');
                await UpdateEngine.updatePresetInPlace({
                    context,
                    store: this.store,
                    presetName: finalName,
                    remoteInspection: inspection,
                    options,
                    fetchImpl: this.fetchImpl,
                });
                this.selected = { type: 'preset', id: finalName };
                this.notify('success', `预设 [${finalName}] 已${mode === 'inplace' ? '原地更新（API 连接已保护）' : '成功导入'}`);
            } else if (targetType === 'worldbook') {
                const finalName = mode === 'inplace' && targetId ? targetId : (inspection.name || '导入世界书');
                const res = await UpdateEngine.updateWorldbookInPlace({
                    context,
                    store: this.store,
                    worldName: finalName,
                    remoteInspection: inspection,
                    options,
                    fetchImpl: this.fetchImpl,
                });
                this.selected = { type: 'worldbook', id: finalName };
                this.notify('success', `世界书 [${finalName}] 已更新（共 ${res.entryCount} 条词条）`);
            }

            this.stagedUpdate = null;
            await this.refreshCatalog();
        } catch (err) {
            this.notify('error', `更新失败: ${err.message}`);
        } finally {
            this.isBusy = false;
            this.render();
        }
    }

    // =========================================================================
    // DOM 渲染层
    // =========================================================================

    render() {
        if (!this.root) return;
        this.root.replaceChildren();

        const shell = createEl('div', 'trh-shell');
        shell.append(
            this._renderTopBar(),
            this._renderMainBody()
        );
        this.root.append(shell);
    }

    _renderTopBar() {
        const context = this.getContext?.();
        const env = PlatformAdapter.detectEnvironment(context);
        const topbar = createEl('header', 'trh-topbar');

        // 1. 左侧品牌与环境状态
        const brandGroup = createEl('div', 'trh-brand-group');
        const logo = createEl('div', 'trh-brand-mark');
        logo.append(createIcon('fa-cubes'));
        const titleWrap = createEl('div', 'trh-brand-titles');
        const title = createEl('h1', 'trh-brand-title', '典藏工坊 · 资源管理器');
        const metaRow = createEl('div', 'trh-env-pills');

        const hostPill = createEl('span', 'trh-env-pill', env.host);
        metaRow.append(hostPill);

        const helperPill = createEl(
            'span',
            `trh-env-pill ${env.hasTavernHelper ? 'is-connected' : 'is-muted'}`,
            env.hasTavernHelper
                ? `酒馆助手已联动${env.tavernHelperVersion && env.tavernHelperVersion !== 'detected' ? ` v${env.tavernHelperVersion}` : ''}`
                : '标准原生模式'
        );
        metaRow.append(helperPill);

        titleWrap.append(title, metaRow);
        brandGroup.append(logo, titleWrap);

        // 2. 中央全局链接输入与解析栏
        const urlBar = createEl('form', 'trh-url-bar');
        const urlIcon = createIcon('fa-link');
        urlIcon.classList.add('trh-url-bar-icon');
        const urlInput = createEl('input', 'trh-url-input');
        urlInput.type = 'url';
        urlInput.id = 'trh_global_url_input';
        urlInput.placeholder = '输入或粘贴角色卡 (.png/.json)、预设或世界书链接（支持 GitHub 自动转 Raw）...';
        if (this.stagedUpdate?.inspection?.sourceUrl) {
            urlInput.value = this.stagedUpdate.inspection.sourceUrl;
        }

        const probeBtn = createEl('button', 'trh-btn trh-btn-accent', this.isBusy ? '解析中...' : '解析链接');
        probeBtn.type = 'submit';
        probeBtn.id = 'trh_global_probe_btn';
        probeBtn.disabled = this.isBusy;

        const fileInput = createEl('input');
        fileInput.type = 'file';
        fileInput.accept = '.png,.json,image/png,application/json';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) this.probeLocalFile(file, this.selected);
        });

        const fileBtn = createEl('button', 'trh-btn trh-btn-ghost', '本地文件');
        fileBtn.type = 'button';
        fileBtn.title = '选择本地 PNG 或 JSON 文件进行原地无损更新';
        fileBtn.prepend(createIcon('fa-folder-open'));
        fileBtn.addEventListener('click', () => fileInput.click());

        urlBar.append(urlIcon, urlInput, probeBtn, fileBtn, fileInput);
        urlBar.addEventListener('submit', (e) => {
            e.preventDefault();
            this.probeUrlForUpdate(urlInput.value);
        });

        // 3. 右侧全局操作按钮组
        const actions = createEl('div', 'trh-topbar-actions');
        const counts = this.getSummaryCounts();

        const checkAllBtn = createEl('button', 'trh-btn trh-btn-subtle');
        checkAllBtn.type = 'button';
        checkAllBtn.id = 'trh_check_all_btn';
        checkAllBtn.disabled = this.isBusy;
        checkAllBtn.append(
            createIcon('fa-arrows-rotate'),
            createEl('span', '', counts.updateCount > 0 ? `检查更新 (${counts.updateCount})` : '检查已绑定更新')
        );
        checkAllBtn.addEventListener('click', () => this.checkAllBoundUpdates());

        const settingsBtn = createEl('button', `trh-btn trh-btn-icon ${this.showSettingsPopover ? 'is-active' : ''}`);
        settingsBtn.type = 'button';
        settingsBtn.title = 'GitHub 加速前缀与默认保护项设置';
        settingsBtn.setAttribute('aria-label', '镜像与偏好设置');
        settingsBtn.append(createIcon('fa-gear'));
        settingsBtn.addEventListener('click', () => {
            this.showSettingsPopover = !this.showSettingsPopover;
            this.render();
        });

        const closeBtn = createEl('button', 'trh-btn trh-btn-ghost trh-close-btn');
        closeBtn.type = 'button';
        closeBtn.id = 'trh_close_workspace_btn';
        closeBtn.append(createIcon('fa-xmark'), createEl('span', '', '返回酒馆'));
        closeBtn.addEventListener('click', () => this.close());

        actions.append(checkAllBtn, settingsBtn, closeBtn);
        topbar.append(brandGroup, urlBar, actions);

        if (this.showSettingsPopover) {
            topbar.append(this._renderSettingsPopover());
        }

        return topbar;
    }

    _renderSettingsPopover() {
        const pop = createEl('div', 'trh-settings-popover');
        const title = createEl('div', 'trh-popover-title', '链接拉取与默认保护设置');

        const mirrorField = createEl('div', 'trh-field-group');
        const mirrorLabel = createEl('label', 'trh-field-label', 'GitHub Raw 加速镜像前缀（可选，留空为官方直连）');
        const mirrorInput = createEl('input', 'trh-input');
        mirrorInput.type = 'url';
        mirrorInput.id = 'trh_mirror_prefix_input';
        mirrorInput.placeholder = '例如 https://ghfast.top';
        mirrorInput.value = this.store.state.githubMirrorPrefix || '';

        const saveMirrorBtn = createEl('button', 'trh-btn trh-btn-accent trh-btn-sm', '保存设置');
        saveMirrorBtn.type = 'button';
        saveMirrorBtn.addEventListener('click', () => {
            this.store.setGithubMirrorPrefix(mirrorInput.value);
            this.showSettingsPopover = false;
            this.notify('success', '链接加速前缀已保存');
            this.render();
        });

        const mirrorRow = createEl('div', 'trh-input-row');
        mirrorRow.append(mirrorInput, saveMirrorBtn);
        mirrorField.append(mirrorLabel, mirrorRow);

        pop.append(title, mirrorField);
        return pop;
    }

    _renderMainBody() {
        const main = createEl('div', 'trh-workspace-body');
        main.append(
            this._renderNavRail(),
            this._renderCenterStage(),
            this._renderInspectorDrawer()
        );
        return main;
    }

    _renderNavRail() {
        const nav = createEl('aside', 'trh-nav-rail');
        const counts = this.getSummaryCounts();

        const navItems = [
            { id: 'character', label: '角色卡', icon: 'fa-id-badge', count: counts.characterCount },
            { id: 'preset', label: '对话预设', icon: 'fa-sliders', count: counts.presetCount },
            { id: 'worldbook', label: '世界书', icon: 'fa-book-atlas', count: counts.worldbookCount },
            { id: 'bound', label: '已绑定更新源', icon: 'fa-cloud-arrow-down', count: counts.boundCount, badge: counts.updateCount },
        ];

        const sectionLabel = createEl('div', 'trh-nav-section-title', '资源分类');
        nav.append(sectionLabel);

        for (const item of navItems) {
            const btn = createEl('button', `trh-nav-item ${this.activeTab === item.id ? 'is-active' : ''}`);
            btn.type = 'button';
            btn.dataset.tab = item.id;

            const left = createEl('span', 'trh-nav-item-left');
            left.append(createIcon(item.icon), createEl('span', '', item.label));

            const right = createEl('span', 'trh-nav-item-right');
            if (item.badge && item.badge > 0) {
                right.append(createEl('span', 'trh-badge trh-badge-amber', `${item.badge} 新版`));
            }
            right.append(createEl('span', 'trh-nav-count', String(item.count)));

            btn.append(left, right);
            btn.addEventListener('click', () => {
                this.activeTab = item.id;
                if (item.id !== 'bound') {
                    const first = this.catalog[item.id]?.[0];
                    if (first && (!this.selected || this.selected.type !== item.id)) {
                        this.selected = { type: item.id, id: first.id };
                    }
                }
                this.render();
            });
            nav.append(btn);
        }

        // 底部当前使用概览卡
        const activeSummary = createEl('div', 'trh-nav-active-card');
        const activeChar = this.catalog.character.find(c => c.isCurrent);
        const activePreset = this.catalog.preset.find(p => p.isCurrent);
        const globalWbs = this.catalog.worldbook.filter(w => w.isGlobalActive);

        activeSummary.append(
            createEl('div', 'trh-nav-section-title', '当前酒馆生效中'),
            this._createActiveMiniRow('角色', activeChar?.name || '未选择'),
            this._createActiveMiniRow('预设', activePreset?.name || '默认'),
            this._createActiveMiniRow('全局书', globalWbs.length ? `${globalWbs.length} 本启用` : '无')
        );
        nav.append(activeSummary);

        return nav;
    }

    _createActiveMiniRow(label, value) {
        const row = createEl('div', 'trh-active-mini-row');
        row.append(
            createEl('span', 'trh-active-mini-label', label),
            createEl('span', 'trh-active-mini-val', value)
        );
        return row;
    }

    _getFilteredItems() {
        const q = this.searchQuery.trim().toLowerCase();

        let rawItems = [];
        if (this.activeTab === 'bound') {
            for (const type of ['character', 'preset', 'worldbook']) {
                for (const item of this.catalog[type]) {
                    const binding = this.store.getBinding(type, item.id);
                    if (binding?.sourceUrl) {
                        rawItems.push({ ...item, resourceType: type, binding });
                    }
                }
            }
        } else {
            const type = this.activeTab;
            rawItems = (this.catalog[type] || []).map(item => ({
                ...item,
                resourceType: type,
                binding: this.store.getBinding(type, item.id),
            }));
        }

        return rawItems.filter(item => {
            if (q) {
                const hay = `${item.name} ${item.id} ${item.creator || ''} ${item.version || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            if (this.activeFilter === 'bound' && !item.binding?.sourceUrl) return false;
            if (this.activeFilter === 'updates' && !item.binding?.hasUpdate) return false;
            if (this.activeFilter === 'helper' && !(item.helperScriptCount > 0 || item.regexCount > 0)) return false;
            if (this.activeFilter === 'active' && !(item.isCurrent || item.isGlobalActive)) return false;
            return true;
        });
    }

    _renderCenterStage() {
        const stage = createEl('main', 'trh-center-stage');

        // 顶部筛选与搜索工具条
        const toolbar = createEl('div', 'trh-stage-toolbar');

        const searchWrap = createEl('div', 'trh-search-box');
        searchWrap.append(createIcon('fa-magnifying-glass'));
        const searchInput = createEl('input', 'trh-search-input');
        searchInput.type = 'search';
        searchInput.placeholder = '按名称、作者、标签或文件名筛选...';
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value;
            this._rerenderGridOnly(gridContainer);
        });
        searchWrap.append(searchInput);

        const filterPills = createEl('div', 'trh-filter-pills');
        const filters = [
            { id: 'all', label: '全部' },
            { id: 'bound', label: '已绑定链接' },
            { id: 'updates', label: '有更新' },
            { id: 'helper', label: '含助手脚本/正则' },
            { id: 'active', label: '当前使用中' },
        ];
        for (const f of filters) {
            const pill = createEl('button', `trh-filter-pill ${this.activeFilter === f.id ? 'is-active' : ''}`, f.label);
            pill.type = 'button';
            pill.addEventListener('click', () => {
                this.activeFilter = f.id;
                this.render();
            });
            filterPills.append(pill);
        }

        toolbar.append(searchWrap, filterPills);

        const gridContainer = createEl('div', 'trh-stage-content');
        this._rerenderGridOnly(gridContainer);

        stage.append(toolbar, gridContainer);
        return stage;
    }

    _rerenderGridOnly(container) {
        container.replaceChildren();
        const items = this._getFilteredItems();

        if (items.length === 0) {
            const empty = createEl('div', 'trh-empty-state');
            empty.append(
                createIcon('fa-box-open'),
                createEl('h3', '', '没有匹配的酒馆资源'),
                createEl('p', '', this.activeTab === 'bound'
                    ? '选中任意角色卡、预设或世界书，在右侧绑定更新源链接后即可在此集中管理更新。'
                    : '你可以在顶部直接输入链接导入，或调整当前筛选条件。')
            );
            container.append(empty);
            return;
        }

        const isCardGrid = this.activeTab === 'character';
        const listEl = createEl('div', isCardGrid ? 'trh-character-grid' : 'trh-resource-list');

        for (const item of items) {
            if (item.resourceType === 'character' && isCardGrid) {
                listEl.append(this._renderCharacterCard(item));
            } else {
                listEl.append(this._renderResourceRow(item));
            }
        }
        container.append(listEl);
    }

    _renderCharacterCard(item) {
        const isSelected = this.selected?.type === 'character' && this.selected?.id === item.id;
        const card = createEl('article', `trh-char-card ${isSelected ? 'is-selected' : ''}`);
        card.dataset.id = item.id;

        // 立绘封面区
        const portrait = createEl('div', 'trh-char-portrait');
        const img = createEl('img', 'trh-char-img');
        img.src = item.avatarUrl;
        img.alt = item.name;
        img.loading = 'lazy';
        img.addEventListener('error', () => {
            img.style.display = 'none';
            portrait.classList.add('is-fallback');
        });
        portrait.append(img);

        // 顶部状态角标
        const topBadges = createEl('div', 'trh-char-top-badges');
        if (item.isCurrent) {
            topBadges.append(createEl('span', 'trh-badge trh-badge-mint', '当前对话'));
        }
        if (item.binding?.hasUpdate) {
            topBadges.append(createEl('span', 'trh-badge trh-badge-amber', '有新版'));
        } else if (item.binding?.sourceUrl) {
            topBadges.append(createEl('span', 'trh-badge trh-badge-slate', '已绑源'));
        }
        portrait.append(topBadges);

        // 信息主体
        const body = createEl('div', 'trh-char-body');
        const titleRow = createEl('div', 'trh-char-title-row');
        const nameEl = createEl('h3', 'trh-char-name', item.name);
        titleRow.append(nameEl);
        if (item.version) {
            titleRow.append(createEl('span', 'trh-mono-tag', `v${item.version.replace(/^v/i, '')}`));
        }

        const metaRow = createEl('div', 'trh-char-meta');
        if (item.worldbookPrimary) {
            const wbTag = createEl('span', 'trh-meta-chip');
            wbTag.append(createIcon('fa-book-atlas'), createEl('span', '', item.worldbookPrimary));
            metaRow.append(wbTag);
        }
        if (item.helperScriptCount > 0) {
            const thTag = createEl('span', 'trh-meta-chip is-accent');
            thTag.append(createIcon('fa-code'), createEl('span', '', `助手脚本 ${item.helperScriptCount}`));
            metaRow.append(thTag);
        }
        if (item.regexCount > 0) {
            const rxTag = createEl('span', 'trh-meta-chip');
            rxTag.append(createEl('span', '', `正则 ${item.regexCount}`));
            metaRow.append(rxTag);
        }

        const footer = createEl('div', 'trh-char-footer');
        const greetingInfo = createEl('span', 'trh-text-muted', `开场白 ${item.greetingCount}`);
        footer.append(greetingInfo);

        if (item.binding?.sourceUrl) {
            const quickUpdateBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-accent', '拉取更新');
            quickUpdateBtn.type = 'button';
            quickUpdateBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selected = { type: 'character', id: item.id };
                this.probeUrlForUpdate(item.binding.sourceUrl, { type: 'character', id: item.id });
            });
            footer.append(quickUpdateBtn);
        }

        body.append(titleRow, metaRow, footer);
        card.append(portrait, body);

        card.addEventListener('click', () => {
            this.selected = { type: 'character', id: item.id };
            this.render();
        });

        return card;
    }

    _renderResourceRow(item) {
        const type = item.resourceType;
        const isSelected = this.selected?.type === type && this.selected?.id === item.id;
        const row = createEl('article', `trh-resource-row ${isSelected ? 'is-selected' : ''}`);
        row.dataset.type = type;
        row.dataset.id = item.id;

        const iconBox = createEl('div', `trh-row-icon is-${type}`);
        iconBox.append(createIcon(TYPE_ICONS[type] || 'fa-cube'));

        const info = createEl('div', 'trh-row-main');
        const head = createEl('div', 'trh-row-head');
        head.append(createEl('h3', 'trh-row-title', item.name));

        if (this.activeTab === 'bound') {
            head.append(createEl('span', 'trh-badge trh-badge-slate', TYPE_LABELS[type]));
        }
        if (item.version) {
            head.append(createEl('span', 'trh-mono-tag', `v${item.version.replace(/^v/i, '')}`));
        }
        if (item.isCurrent) {
            head.append(createEl('span', 'trh-badge trh-badge-mint', '当前使用'));
        }
        if (item.isGlobalActive) {
            head.append(createEl('span', 'trh-badge trh-badge-mint', '全局启用'));
        }
        if (item.binding?.hasUpdate) {
            head.append(createEl('span', 'trh-badge trh-badge-amber', '可更新'));
        }

        const sub = createEl('div', 'trh-row-sub');
        if (type === 'preset') {
            sub.append(createEl('span', '', `提示词 ${item.enabledPromptCount}/${item.promptCount}`));
            if (item.temperature !== null) sub.append(createEl('span', 'trh-mono-inline', `Temp ${item.temperature}`));
            if (item.maxContext !== null) sub.append(createEl('span', 'trh-mono-inline', `Ctx ${item.maxContext}`));
            if (item.helperScriptCount > 0) sub.append(createEl('span', 'trh-meta-chip is-accent', `助手脚本 ${item.helperScriptCount}`));
            if (item.regexCount > 0) sub.append(createEl('span', 'trh-meta-chip', `正则 ${item.regexCount}`));
        } else if (type === 'worldbook') {
            sub.append(createEl('span', '', `词条 ${item.enabledEntryCount}/${item.entryCount}`));
            if (item.boundCharacters?.length > 0) {
                sub.append(createEl('span', 'trh-meta-chip', `绑定角色: ${item.boundCharacters.map(c => c.name).join(', ')}`));
            }
        } else if (type === 'character') {
            sub.append(createEl('span', '', `文件: ${item.avatar}`));
            if (item.worldbookPrimary) sub.append(createEl('span', 'trh-meta-chip', `世界书: ${item.worldbookPrimary}`));
        }

        if (item.binding?.sourceUrl) {
            let host = '已绑定源';
            try { host = new URL(item.binding.sourceUrl).hostname; } catch {}
            sub.append(createEl('span', 'trh-mono-inline', `源: ${host} · ${formatTime(item.binding.lastUpdatedAt)}`));
        }

        info.append(head, sub);

        const actions = createEl('div', 'trh-row-actions');
        if (type === 'preset' && !item.isCurrent) {
            const useBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-ghost', '设为当前');
            useBtn.type = 'button';
            useBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await PlatformAdapter.activatePreset(this.getContext?.(), item.name);
                this.notify('success', `已切换至预设: ${item.name}`);
                await this.refreshCatalog();
            });
            actions.append(useBtn);
        }

        if (type === 'worldbook') {
            const toggleBtn = createEl(
                'button',
                `trh-btn trh-btn-xs ${item.isGlobalActive ? 'trh-btn-subtle' : 'trh-btn-ghost'}`,
                item.isGlobalActive ? '取消全局' : '全局启用'
            );
            toggleBtn.type = 'button';
            toggleBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await PlatformAdapter.toggleGlobalWorldbook(this.getContext?.(), item.name, !item.isGlobalActive);
                await this.refreshCatalog();
            });
            actions.append(toggleBtn);
        }

        if (item.binding?.sourceUrl) {
            const pullBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-accent', '拉取更新');
            pullBtn.type = 'button';
            pullBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selected = { type, id: item.id };
                this.probeUrlForUpdate(item.binding.sourceUrl, { type, id: item.id });
            });
            actions.append(pullBtn);
        }

        row.append(iconBox, info, actions);
        row.addEventListener('click', () => {
            this.selected = { type, id: item.id };
            this.render();
        });

        return row;
    }

    // =========================================================================
    // 右侧详情与原地更新抽屉
    // =========================================================================

    _renderInspectorDrawer() {
        const drawer = createEl('aside', 'trh-inspector');

        // 如果存在已解析待确认的远端更新包，优先展示原地更新预览与确认工作流
        if (this.stagedUpdate) {
            drawer.append(this._renderStagedUpdatePanel());
            return drawer;
        }

        if (!this.selected) {
            const empty = createEl('div', 'trh-inspector-empty');
            empty.append(
                createIcon('fa-hand-pointer'),
                createEl('p', '', '在左侧选择任意角色卡、预设或世界书，即可绑定更新源链接、管理关联世界书或执行原地更新。')
            );
            drawer.append(empty);
            return drawer;
        }

        const { type, id } = this.selected;
        const item = (this.catalog[type] || []).find(entry => entry.id === id);
        if (!item) {
            const empty = createEl('div', 'trh-inspector-empty', '未找到所选资源');
            drawer.append(empty);
            return drawer;
        }

        const binding = this.store.getBinding(type, id);
        const snapshot = this.store.getSnapshot(type, id);

        // 1. 头部概要
        const header = createEl('div', 'trh-inspector-header');
        const typeBadge = createEl('span', 'trh-badge trh-badge-slate', TYPE_LABELS[type]);
        const title = createEl('h2', 'trh-inspector-title', item.name);
        const idLine = createEl('div', 'trh-mono-sub', `标识: ${item.id}${item.version ? ` · 版本: v${item.version.replace(/^v/i, '')}` : ''}`);
        header.append(typeBadge, title, idLine);

        // 若有更新前快照，提供一键回滚卡片
        if (snapshot) {
            const rollbackBar = createEl('div', 'trh-rollback-banner');
            const rbText = createEl('span', '', `存在 ${formatTime(snapshot.savedAt)} 的更新前备份`);
            const rbBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-ghost', '一键回滚');
            rbBtn.type = 'button';
            rbBtn.addEventListener('click', async () => {
                try {
                    await UpdateEngine.rollbackResource({
                        context: this.getContext?.(),
                        store: this.store,
                        type,
                        id,
                        fetchImpl: this.fetchImpl,
                    });
                    this.notify('success', `[${item.name}] 已回滚至更新前版本`);
                    await this.refreshCatalog();
                } catch (err) {
                    this.notify('error', `回滚失败: ${err.message}`);
                }
            });
            rollbackBar.append(rbText, rbBtn);
            header.append(rollbackBar);
        }

        drawer.append(header);

        // 2. 更新源链接绑定卡片
        const urlSection = createEl('section', 'trh-inspector-section');
        const urlHead = createEl('div', 'trh-section-head');
        urlHead.append(createIcon('fa-link'), createEl('h3', '', '更新源链接绑定 (支持直链与 GitHub)'));

        const urlInput = createEl('input', 'trh-input');
        urlInput.type = 'url';
        urlInput.id = 'trh_inspector_url_input';
        urlInput.placeholder = `输入该${TYPE_LABELS[type]}的直链或 GitHub 链接...`;
        urlInput.value = binding?.sourceUrl || '';

        const btnRow = createEl('div', 'trh-btn-row');
        const saveBindBtn = createEl('button', 'trh-btn trh-btn-subtle trh-btn-sm', '保存绑定链接');
        saveBindBtn.type = 'button';
        saveBindBtn.addEventListener('click', () => {
            const val = urlInput.value.trim();
            if (!val) {
                this.store.removeBinding(type, id);
                this.notify('info', `已清除 [${item.name}] 的绑定链接`);
                this.render();
                return;
            }
            try {
                normalizeResourceUrl(val, { githubMirrorPrefix: this.store.state.githubMirrorPrefix });
                this.store.setBinding(type, id, { sourceUrl: val });
                this.notify('success', `已为 [${item.name}] 绑定更新源链接`);
                this.render();
            } catch (err) {
                this.notify('error', err.message);
            }
        });

        const pullNowBtn = createEl('button', 'trh-btn trh-btn-accent trh-btn-sm', '从链接拉取并更新');
        pullNowBtn.type = 'button';
        pullNowBtn.id = 'trh_inspector_pull_btn';
        pullNowBtn.disabled = this.isBusy;
        pullNowBtn.addEventListener('click', () => {
            const val = urlInput.value.trim();
            if (!val) {
                this.notify('warning', '请先在上方输入框填入更新链接');
                return;
            }
            this.store.setBinding(type, id, { sourceUrl: val });
            this.probeUrlForUpdate(val, { type, id });
        });

        btnRow.append(saveBindBtn, pullNowBtn);
        urlSection.append(urlHead, urlInput, btnRow);

        if (binding?.lastUpdatedAt) {
            const syncMeta = createEl(
                'div',
                'trh-mono-sub',
                `上次更新: ${formatTime(binding.lastUpdatedAt)}${binding.lastHash ? ` · SHA256: ${binding.lastHash.slice(0, 10)}...` : ''}`
            );
            urlSection.append(syncMeta);
        }
        drawer.append(urlSection);

        // 3. 类型专属联动管理区
        if (type === 'character') {
            drawer.append(this._renderCharacterRelationsSection(item, binding));
        } else if (type === 'preset') {
            drawer.append(this._renderPresetDetailsSection(item));
        } else if (type === 'worldbook') {
            drawer.append(this._renderWorldbookDetailsSection(item));
        }

        return drawer;
    }

    _renderCharacterRelationsSection(charItem, binding) {
        const wrap = createEl('div', 'trh-inspector-sections-wrap');

        // A. 角色卡 ↔ 世界书 & 预设 联动绑定
        const relSec = createEl('section', 'trh-inspector-section');
        const relHead = createEl('div', 'trh-section-head');
        relHead.append(createIcon('fa-diagram-project'), createEl('h3', '', '世界书与预设联动'));
        relSec.append(relHead);

        // 主世界书选择
        const wbField = createEl('div', 'trh-field-group');
        wbField.append(createEl('label', 'trh-field-label', '绑定主世界书 (Primary Worldbook)'));
        const wbSelect = createEl('select', 'trh-select');
        const emptyOpt = createEl('option', '', '— 未绑定主世界书 —');
        emptyOpt.value = '';
        wbSelect.append(emptyOpt);

        for (const wb of this.catalog.worldbook) {
            const opt = createEl('option', '', `${wb.name} (${wb.entryCount} 词条)`);
            opt.value = wb.name;
            if (wb.name === charItem.worldbookPrimary) opt.selected = true;
            wbSelect.append(opt);
        }
        wbSelect.addEventListener('change', async () => {
            try {
                await PlatformAdapter.rebindCharacterWorldbooks(
                    this.getContext?.(),
                    charItem.id,
                    { primary: wbSelect.value || null, additional: charItem.worldbookAdditional },
                    { fetchImpl: this.fetchImpl }
                );
                this.notify('success', `已更新 [${charItem.name}] 的主世界书绑定`);
                await this.refreshCatalog();
            } catch (err) {
                this.notify('error', `绑定世界书失败: ${err.message}`);
            }
        });
        wbField.append(wbSelect);
        relSec.append(wbField);

        // 如果卡内含内置世界书 (character_book)，支持一键提取/同步为独立世界书
        if (charItem.hasEmbeddedBook) {
            const extractRow = createEl('div', 'trh-embedded-book-bar');
            extractRow.append(
                createEl('span', '', `含内置世界书: ${charItem.embeddedBookName || `${charItem.name}_World`}`)
            );
            const extractBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-subtle', '提取并同步到世界书');
            extractBtn.type = 'button';
            extractBtn.addEventListener('click', async () => {
                try {
                    const context = this.getContext?.();
                    const { charObj } = await PlatformAdapter.getCharacterFullData(context, charItem.id);
                    const norm = normalizeCharacterPayload(charObj);
                    if (!norm.character_book) throw new Error('未读取到内置世界书数据');
                    const targetWbName = charItem.worldbookPrimary || norm.character_book.name || `${charItem.name}_World`;
                    await PlatformAdapter.saveWorldbookInPlace(context, targetWbName, norm.character_book, {
                        fetchImpl: this.fetchImpl,
                    });
                    await PlatformAdapter.rebindCharacterWorldbooks(
                        context,
                        charItem.id,
                        { primary: targetWbName, additional: charItem.worldbookAdditional },
                        { fetchImpl: this.fetchImpl }
                    );
                    this.notify('success', `已提取并绑定内置世界书: ${targetWbName}`);
                    await this.refreshCatalog();
                } catch (err) {
                    this.notify('error', err.message);
                }
            });
            extractRow.append(extractBtn);
            relSec.append(extractRow);
        }

        // 关联推荐预设
        const presetField = createEl('div', 'trh-field-group');
        presetField.append(createEl('label', 'trh-field-label', '关联配套预设（可一键切换）'));
        const presetRow = createEl('div', 'trh-input-row');
        const presetSelect = createEl('select', 'trh-select');
        const noPresetOpt = createEl('option', '', '— 未指定关联预设 —');
        noPresetOpt.value = '';
        presetSelect.append(noPresetOpt);

        const linkedPreset = binding?.linkedPreset || '';
        for (const p of this.catalog.preset) {
            const opt = createEl('option', '', p.name);
            opt.value = p.name;
            if (p.name === linkedPreset) opt.selected = true;
            presetSelect.append(opt);
        }
        presetSelect.addEventListener('change', () => {
            this.store.setBinding('character', charItem.id, { linkedPreset: presetSelect.value });
            this.render();
        });

        const applyPresetBtn = createEl('button', 'trh-btn trh-btn-subtle trh-btn-sm', '启用该预设');
        applyPresetBtn.type = 'button';
        applyPresetBtn.disabled = !linkedPreset;
        applyPresetBtn.addEventListener('click', async () => {
            if (!linkedPreset) return;
            await PlatformAdapter.activatePreset(this.getContext?.(), linkedPreset);
            this.notify('success', `已为角色 [${charItem.name}] 启用预设: ${linkedPreset}`);
            await this.refreshCatalog();
        });

        presetRow.append(presetSelect, applyPresetBtn);
        presetField.append(presetRow);
        relSec.append(presetField);
        wrap.append(relSec);

        // B. 酒馆助手脚本与正则概览
        const scriptSec = createEl('section', 'trh-inspector-section');
        const scriptHead = createEl('div', 'trh-section-head');
        scriptHead.append(createIcon('fa-code'), createEl('h3', '', '内置脚本、正则与设定概览'));
        scriptSec.append(scriptHead);

        const statsGrid = createEl('div', 'trh-stats-grid');
        statsGrid.append(
            this._createStatBox('开场白数量', String(charItem.greetingCount)),
            this._createStatBox('局部正则', String(charItem.regexCount)),
            this._createStatBox('酒馆助手脚本', String(charItem.helperScriptCount)),
            this._createStatBox('当前会话文件', charItem.chat || '默认')
        );
        scriptSec.append(statsGrid);
        wrap.append(scriptSec);

        return wrap;
    }

    _renderPresetDetailsSection(presetItem) {
        const sec = createEl('section', 'trh-inspector-section');
        const head = createEl('div', 'trh-section-head');
        head.append(createIcon('fa-sliders'), createEl('h3', '', '预设参数与内置脚本概览'));
        sec.append(head);

        const statsGrid = createEl('div', 'trh-stats-grid');
        statsGrid.append(
            this._createStatBox('提示词条目', `${presetItem.enabledPromptCount} 启用 / ${presetItem.promptCount} 总计`),
            this._createStatBox('采样温度', String(presetItem.temperature ?? '-')),
            this._createStatBox('上下文上限', String(presetItem.maxContext ?? '-')),
            this._createStatBox('助手脚本 / 正则', `${presetItem.helperScriptCount} 脚本 / ${presetItem.regexCount} 正则`)
        );
        sec.append(statsGrid);

        if (!presetItem.isCurrent) {
            const activateBtn = createEl('button', 'trh-btn trh-btn-subtle trh-btn-block', '将此预设设为当前使用');
            activateBtn.type = 'button';
            activateBtn.addEventListener('click', async () => {
                await PlatformAdapter.activatePreset(this.getContext?.(), presetItem.name);
                this.notify('success', `已切换至预设: ${presetItem.name}`);
                await this.refreshCatalog();
            });
            sec.append(activateBtn);
        }

        return sec;
    }

    _renderWorldbookDetailsSection(wbItem) {
        const sec = createEl('section', 'trh-inspector-section');
        const head = createEl('div', 'trh-section-head');
        head.append(createIcon('fa-book-atlas'), createEl('h3', '', '世界书词条与绑定概览'));
        sec.append(head);

        const statsGrid = createEl('div', 'trh-stats-grid');
        statsGrid.append(
            this._createStatBox('启用词条 / 总词条', `${wbItem.enabledEntryCount} / ${wbItem.entryCount}`),
            this._createStatBox('全局激活状态', wbItem.isGlobalActive ? '已全局启用' : '未全局启用')
        );
        sec.append(statsGrid);

        if (wbItem.boundCharacters?.length > 0) {
            const boundBox = createEl('div', 'trh-field-group');
            boundBox.append(createEl('div', 'trh-field-label', '已绑定该世界书的角色卡'));
            const chipRow = createEl('div', 'trh-chip-wrap');
            for (const c of wbItem.boundCharacters) {
                const chip = createEl('span', 'trh-meta-chip', `${c.name} (${c.isPrimary ? '主书' : '附加'})`);
                chipRow.append(chip);
            }
            boundBox.append(chipRow);
            sec.append(boundBox);
        }

        return sec;
    }

    _createStatBox(label, value) {
        const box = createEl('div', 'trh-stat-box');
        box.append(
            createEl('div', 'trh-stat-label', label),
            createEl('div', 'trh-stat-value', value)
        );
        return box;
    }

    // =========================================================================
    // 原地更新差异预览与保护项确认面板
    // =========================================================================

    _renderStagedUpdatePanel() {
        const { inspection, targetType, targetId, mode, preview, options } = this.stagedUpdate;
        const panel = createEl('div', 'trh-staged-panel');

        const header = createEl('div', 'trh-staged-header');
        const badge = createEl('span', 'trh-badge trh-badge-amber', `待确认 · ${TYPE_LABELS[targetType]}更新`);
        const title = createEl('h2', 'trh-inspector-title', inspection.name);
        const sub = createEl(
            'div',
            'trh-mono-sub',
            `格式: ${inspection.format.toUpperCase()} · 大小: ${(inspection.byteLength / 1024).toFixed(1)} KB · SHA256: ${inspection.hash.slice(0, 10)}`
        );
        header.append(badge, title, sub);
        panel.append(header);

        // 1. 选择更新方式：原地更新现有资源 vs 导入为新资源
        const modeSec = createEl('section', 'trh-inspector-section');
        modeSec.append(createEl('div', 'trh-field-label', '更新模式与目标资源'));

        const modeToggle = createEl('div', 'trh-mode-switch');
        const inplaceBtn = createEl('button', `trh-mode-btn ${mode === 'inplace' ? 'is-active' : ''}`, '原地更新现有资源 (推荐)');
        inplaceBtn.type = 'button';
        const createBtn = createEl('button', `trh-mode-btn ${mode === 'create' ? 'is-active' : ''}`, '作为新资源导入');
        createBtn.type = 'button';

        inplaceBtn.addEventListener('click', async () => {
            this.stagedUpdate.mode = 'inplace';
            const list = this.catalog[targetType] || [];
            if (!this.stagedUpdate.targetId && list.length > 0) {
                this.stagedUpdate.targetId = list[0].id;
            }
            if (this.stagedUpdate.targetId) {
                this.stagedUpdate.preview = await this._computePreviewForTarget(targetType, this.stagedUpdate.targetId, inspection);
            }
            this.render();
        });
        createBtn.addEventListener('click', () => {
            this.stagedUpdate.mode = 'create';
            this.render();
        });
        modeToggle.append(inplaceBtn, createBtn);
        modeSec.append(modeToggle);

        if (mode === 'inplace') {
            const targetSelect = createEl('select', 'trh-select');
            targetSelect.id = 'trh_staged_target_select';
            const list = this.catalog[targetType] || [];
            for (const item of list) {
                const opt = createEl('option', '', `${item.name} (${item.id})`);
                opt.value = item.id;
                if (item.id === targetId) opt.selected = true;
                targetSelect.append(opt);
            }
            targetSelect.addEventListener('change', async () => {
                this.stagedUpdate.targetId = targetSelect.value;
                this.stagedUpdate.preview = await this._computePreviewForTarget(targetType, targetSelect.value, inspection);
                this.render();
            });
            modeSec.append(targetSelect);
        }
        panel.append(modeSec);

        // 2. 差异预览摘要
        if (mode === 'inplace' && preview) {
            const diffSec = createEl('section', 'trh-inspector-section');
            const diffHead = createEl('div', 'trh-section-head');
            diffHead.append(createIcon('fa-code-compare'), createEl('h3', '', '版本与内容差异对比'));
            diffSec.append(diffHead);

            const verLine = createEl(
                'div',
                'trh-diff-version-line',
                `版本变化: ${preview.localVersion} → ${preview.remoteVersion}`
            );
            diffSec.append(verLine);

            if (preview.isIdentical) {
                diffSec.append(createEl('div', 'trh-diff-identical', '远端内容与本地完全一致（仍可强制覆盖重写）'));
            } else if (preview.changedFields.length > 0) {
                const list = createEl('ul', 'trh-diff-list');
                for (const field of preview.changedFields) {
                    list.append(createEl('li', '', field));
                }
                diffSec.append(list);
            }
            panel.append(diffSec);
        }

        // 3. 原地无损保护项勾选
        if (mode === 'inplace') {
            const protSec = createEl('section', 'trh-inspector-section');
            const protHead = createEl('div', 'trh-section-head');
            protHead.append(createIcon('fa-shield-halved'), createEl('h3', '', '原地更新数据保护项'));
            protSec.append(protHead);

            const checkboxes = this._getProtectionCheckboxes(targetType, inspection);
            for (const cb of checkboxes) {
                const label = createEl('label', 'trh-checkbox-row');
                const input = createEl('input');
                input.type = 'checkbox';
                input.checked = Boolean(options[cb.key]);
                input.addEventListener('change', () => {
                    this.stagedUpdate.options[cb.key] = input.checked;
                });
                label.append(input, createEl('span', '', cb.label));
                protSec.append(label);
            }
            panel.append(protSec);
        }

        // 4. 确认与取消按钮
        const footer = createEl('div', 'trh-staged-footer');
        const cancelBtn = createEl('button', 'trh-btn trh-btn-ghost', '取消');
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', () => {
            this.stagedUpdate = null;
            this.render();
        });

        const confirmBtn = createEl(
            'button',
            'trh-btn trh-btn-accent',
            this.isBusy ? '正在写入...' : (mode === 'inplace' ? '确认原地更新' : '确认导入新资源')
        );
        confirmBtn.type = 'button';
        confirmBtn.id = 'trh_confirm_staged_update_btn';
        confirmBtn.disabled = this.isBusy || (mode === 'inplace' && !this.stagedUpdate.targetId);
        confirmBtn.addEventListener('click', () => this.executeStagedUpdate());

        footer.append(cancelBtn, confirmBtn);
        panel.append(footer);

        return panel;
    }

    _getProtectionCheckboxes(type, inspection) {
        if (type === 'character') {
            const list = [
                { key: 'preserveWorldbookBinding', label: '保留本地已绑定的世界书（不丢失原世界书关联）' },
                { key: 'preserveHelperVariables', label: '保留酒馆助手脚本变量 (tavern_helper.variables)' },
                { key: 'preserveFavorite', label: '保留本地收藏状态' },
                { key: 'preserveFirstMessage', label: '保留本地现有开场白（不覆盖 first_mes）' },
                { key: 'preserveRegexScripts', label: '保留本地现有局部正则脚本' },
            ];
            if (inspection?.summary?.hasCharacterBook) {
                list.splice(1, 0, {
                    key: 'syncEmbeddedWorldbook',
                    label: `同步更新卡内自带的内置世界书 (${inspection.summary.characterBookName || 'Character Book'})`,
                });
            }
            return list;
        }
        if (type === 'preset') {
            return [
                { key: 'protectConnectionFields', label: '保护本地 API 连接地址、来源与模型（防止断连）' },
                { key: 'preserveHelperVariables', label: '保留预设内酒馆助手脚本变量 (tavern_helper.variables)' },
                { key: 'preservePromptToggles', label: '保留本地同名提示词条目的启用/关闭开关状态' },
            ];
        }
        return [
            { key: 'mergeKeepLocalOnlyEntries', label: '合并保留仅在本地存在的自定义词条（不勾选则完全同步为远端词条）' },
        ];
    }
}
