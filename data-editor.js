/**
 * Tavern-Resource-Hub: Internal Data Viewer & Editor Modal (分页式编辑器)
 * 支持底部分页切换：
 * - 角色卡：基础设定 / 开场白 / 提示与示例 / JSON 源码
 * - 预设：提示词列表 / 条目编辑 / 采样参数 / JSON 源码
 * - 世界书：词条列表 / 词条编辑 / JSON 源码
 */

import { normalizeCharacterPayload, normalizeWorldbookPayload } from './card-codec.js';
import { PlatformAdapter } from './platform.js';

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

function createField(labelText, controlEl) {
    const group = createEl('div', 'trh-field-group');
    group.append(createEl('label', 'trh-field-label', labelText), controlEl);
    return group;
}

function createTextInput(value, onInput, placeholder = '') {
    const input = createEl('input', 'trh-input');
    input.type = 'text';
    input.value = value ?? '';
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('input', () => onInput(input.value));
    return input;
}

function createNumberInput(value, onInput, step = 'any') {
    const input = createEl('input', 'trh-input');
    input.type = 'number';
    input.step = step;
    input.value = value ?? '';
    input.addEventListener('input', () => {
        const num = input.value === '' ? undefined : Number(input.value);
        onInput(Number.isFinite(num) ? num : undefined);
    });
    return input;
}

function createTextArea(value, onInput, rows = 4, placeholder = '') {
    const ta = createEl('textarea', 'trh-textarea');
    ta.rows = rows;
    ta.value = value ?? '';
    if (placeholder) ta.placeholder = placeholder;
    ta.addEventListener('input', () => onInput(ta.value));
    return ta;
}

export class ResourceDataEditor {
    constructor({
        getContext,
        store,
        fetchImpl = globalThis.fetch,
        onNotify = null,
        onSaved = null,
    }) {
        this.getContext = getContext;
        this.store = store;
        this.fetchImpl = fetchImpl;
        this.onNotify = onNotify;
        this.onSaved = onSaved;

        this.backdrop = null;
        this.isOpen = false;
        this.type = null; // 'character' | 'preset' | 'worldbook'
        this.id = null;
        this.title = '';
        this.activePage = 'basic';
        this.draft = null;
        this.jsonText = '';
        this.jsonError = '';
        this.entrySearch = '';
        this.selectedPromptIdx = 0;
        this.selectedWorldKey = null;
        this.isSaving = false;
    }

    notify(level, msg) {
        if (typeof this.onNotify === 'function') {
            this.onNotify(level, msg);
        }
    }

    _getPagesForType(type) {
        if (type === 'character') {
            return [
                { id: 'basic', label: '基础设定', icon: 'fa-id-card' },
                { id: 'greetings', label: '开场白', icon: 'fa-comments' },
                { id: 'prompts', label: '提示与示例', icon: 'fa-wand-magic-sparkles' },
                { id: 'json', label: 'JSON', icon: 'fa-code' },
            ];
        }
        if (type === 'preset') {
            return [
                { id: 'list', label: '提示词列表', icon: 'fa-list-check' },
                { id: 'item', label: '条目编辑', icon: 'fa-pen-nib' },
                { id: 'params', label: '采样参数', icon: 'fa-sliders' },
                { id: 'json', label: 'JSON', icon: 'fa-code' },
            ];
        }
        return [
            { id: 'list', label: '词条列表', icon: 'fa-book-open' },
            { id: 'item', label: '词条编辑', icon: 'fa-pen-nib' },
            { id: 'json', label: 'JSON', icon: 'fa-code' },
        ];
    }

    async open({ type, id, name, parentEl }) {
        const context = this.getContext?.();
        let rawData;
        if (type === 'character') {
            const full = await PlatformAdapter.getCharacterFullData(context, id, { fetchImpl: this.fetchImpl });
            rawData = normalizeCharacterPayload(full.charObj).v2Object;
            rawData.avatar = full.avatarId;
            rawData.chat = full.charObj.chat || '';
            if (full.charObj.create_date) rawData.create_date = full.charObj.create_date;
        } else if (type === 'preset') {
            rawData = await PlatformAdapter.getPresetFullData(context, id, { fetchImpl: this.fetchImpl });
        } else if (type === 'worldbook') {
            rawData = await PlatformAdapter.getWorldbookFullData(context, id, { fetchImpl: this.fetchImpl });
            rawData = normalizeWorldbookPayload(rawData).bookData;
        } else {
            throw new Error(`不支持编辑的资源类型: ${type}`);
        }

        this.type = type;
        this.id = id;
        this.title = name || id;
        this.activePage = type === 'character' ? 'basic' : 'list';
        this.draft = structuredClone(rawData);
        this.jsonText = JSON.stringify(this.draft, null, 2);
        this.jsonError = '';
        this.entrySearch = '';
        this.selectedPromptIdx = 0;
        this.selectedWorldKey = type === 'worldbook' ? (Object.keys(this.draft.entries || {})[0] || null) : null;
        this.isSaving = false;

        if (!this.backdrop) {
            this.backdrop = createEl('div', 'trh-editor-backdrop');
            this.backdrop.id = 'trh_data_editor_modal';
            this.backdrop.addEventListener('click', (e) => {
                if (e.target === this.backdrop) this.close();
            });
        }
        (parentEl || document.body).append(this.backdrop);
        this.isOpen = true;
        this.render();
    }

    close() {
        this.isOpen = false;
        if (this.backdrop?.isConnected) {
            this.backdrop.remove();
        }
    }

    _syncFromJsonText() {
        try {
            const parsed = JSON.parse(this.jsonText);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                this.jsonError = '根节点必须是有效的 JSON 对象';
                return false;
            }
            this.draft = parsed;
            this.jsonError = '';
            return true;
        } catch (err) {
            this.jsonError = `JSON 语法错误: ${err.message}`;
            return false;
        }
    }

    _switchPage(nextPageId) {
        if (nextPageId === this.activePage) return;
        if (this.activePage === 'json') {
            if (!this._syncFromJsonText()) {
                this.render();
                this.notify('error', this.jsonError);
                return;
            }
        }
        if (nextPageId === 'json') {
            this.jsonText = JSON.stringify(this.draft, null, 2);
            this.jsonError = '';
        }
        this.activePage = nextPageId;
        this.render({ resetScroll: true });
    }

    async save() {
        if (this.activePage === 'json' && !this._syncFromJsonText()) {
            this.render();
            this.notify('error', this.jsonError);
            return;
        }

        const context = this.getContext?.();
        this.isSaving = true;
        this.render();

        try {
            if (this.type === 'character') {
                const full = await PlatformAdapter.getCharacterFullData(context, this.id);
                const prevNorm = normalizeCharacterPayload(full.charObj);
                this.store.saveSnapshot('character', this.id, prevNorm.v2Object, {
                    name: prevNorm.name,
                    version: prevNorm.version,
                });
                const merged = normalizeCharacterPayload(this.draft).v2Object;
                merged.avatar = this.id;
                merged.chat = full.charObj.chat || '';
                if (full.charObj.create_date) merged.create_date = full.charObj.create_date;
                await PlatformAdapter.saveCharacterInPlace(context, this.id, merged, {
                    fetchImpl: this.fetchImpl,
                });
            } else if (this.type === 'preset') {
                const prev = await PlatformAdapter.getPresetFullData(context, this.id, { fetchImpl: this.fetchImpl });
                this.store.saveSnapshot('preset', this.id, prev, { name: this.id });
                await PlatformAdapter.savePresetInPlace(context, this.id, this.draft, {
                    fetchImpl: this.fetchImpl,
                });
            } else if (this.type === 'worldbook') {
                const prev = await PlatformAdapter.getWorldbookFullData(context, this.id, { fetchImpl: this.fetchImpl });
                this.store.saveSnapshot('worldbook', this.id, prev, { name: this.id });
                await PlatformAdapter.saveWorldbookInPlace(context, this.id, this.draft, {
                    fetchImpl: this.fetchImpl,
                });
            }

            this.notify('success', `已保存对「${this.title}」的修改`);
            this.close();
            await this.onSaved?.();
        } catch (err) {
            this.notify('error', `保存失败: ${err.message}`);
        } finally {
            this.isSaving = false;
            if (this.isOpen) this.render();
        }
    }

    render({ resetScroll = false } = {}) {
        if (!this.backdrop || !this.isOpen) return;
        const prevBodyScroll = resetScroll ? 0 : (this.backdrop.querySelector('.trh-editor-body')?.scrollTop || 0);
        this.backdrop.replaceChildren();

        const modal = createEl('div', 'trh-editor-modal');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        // 1. 顶部精简标题与保存/关闭操作栏
        const header = createEl('div', 'trh-editor-header');
        const titleWrap = createEl('div', 'trh-editor-title-wrap');
        const typeLabel = { character: '角色卡', preset: '预设', worldbook: '世界书' }[this.type] || '数据';
        titleWrap.append(
            createEl('span', 'trh-badge trh-badge-slate', typeLabel),
            createEl('h2', 'trh-editor-title', this.title)
        );

        const headActions = createEl('div', 'trh-editor-head-actions');
        const saveBtn = createEl('button', 'trh-btn trh-btn-sm trh-btn-accent', this.isSaving ? '保存中...' : '保存修改');
        saveBtn.type = 'button';
        saveBtn.id = 'trh_editor_save_btn';
        saveBtn.disabled = this.isSaving;
        saveBtn.addEventListener('click', () => this.save());

        const closeBtn = createEl('button', 'trh-btn trh-btn-icon');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', '关闭编辑器');
        closeBtn.append(createIcon('fa-xmark'));
        closeBtn.addEventListener('click', () => this.close());

        headActions.append(saveBtn, closeBtn);
        header.append(titleWrap, headActions);

        // 2. 中间分页内容区
        const body = createEl('div', 'trh-editor-body');
        if (this.activePage === 'json') {
            body.append(this._renderJsonEditor());
        } else if (this.type === 'character') {
            body.append(this._renderCharacterPage());
        } else if (this.type === 'preset') {
            body.append(this._renderPresetPage());
        } else if (this.type === 'worldbook') {
            body.append(this._renderWorldbookPage());
        }

        // 3. 底部可切换分页导航栏
        const bottomTabs = createEl('nav', 'trh-editor-bottom-tabs');
        bottomTabs.setAttribute('aria-label', '编辑器分页');
        for (const page of this._getPagesForType(this.type)) {
            const tabBtn = createEl('button', `trh-editor-tab-btn ${this.activePage === page.id ? 'is-active' : ''}`);
            tabBtn.type = 'button';
            tabBtn.dataset.page = page.id;
            tabBtn.append(createIcon(page.icon), createEl('span', '', page.label));
            tabBtn.addEventListener('click', () => this._switchPage(page.id));
            bottomTabs.append(tabBtn);
        }

        modal.append(header, body, bottomTabs);
        this.backdrop.append(modal);

        if (!resetScroll && prevBodyScroll > 0) {
            body.scrollTop = prevBodyScroll;
        }
    }

    _renderJsonEditor() {
        const wrap = createEl('div', 'trh-json-wrap');
        const toolbar = createEl('div', 'trh-json-toolbar');
        const formatBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-subtle', '格式化 JSON');
        formatBtn.type = 'button';
        formatBtn.addEventListener('click', () => {
            if (this._syncFromJsonText()) {
                this.jsonText = JSON.stringify(this.draft, null, 2);
            }
            this.render();
        });
        toolbar.append(formatBtn);
        if (this.jsonError) {
            toolbar.append(createEl('span', 'trh-json-error', this.jsonError));
        }

        const ta = createEl('textarea', 'trh-json-textarea');
        ta.id = 'trh_editor_json_textarea';
        ta.spellcheck = false;
        ta.value = this.jsonText;
        ta.addEventListener('input', () => {
            this.jsonText = ta.value;
        });

        wrap.append(toolbar, ta);
        return wrap;
    }

    // =========================================================================
    // 角色卡分页
    // =========================================================================

    _renderCharacterPage() {
        const d = this.draft.data || (this.draft.data = {});
        const wrap = createEl('div', 'trh-form-stack');

        if (this.activePage === 'basic') {
            const grid = createEl('div', 'trh-form-grid-2');
            grid.append(
                createField('角色名称 (name)', createTextInput(d.name ?? this.draft.name, v => {
                    d.name = v;
                    this.draft.name = v;
                })),
                createField('版本号 (character_version)', createTextInput(d.character_version, v => {
                    d.character_version = v;
                })),
                createField('作者 (creator)', createTextInput(d.creator, v => {
                    d.creator = v;
                })),
                createField('标签 (tags，英文逗号分隔)', createTextInput(
                    Array.isArray(d.tags) ? d.tags.join(', ') : '',
                    v => {
                        const tags = v.split(',').map(s => s.trim()).filter(Boolean);
                        d.tags = tags;
                        this.draft.tags = tags;
                    }
                ))
            );
            wrap.append(
                grid,
                createField('角色描述 (description)', createTextArea(d.description ?? this.draft.description, v => {
                    d.description = v;
                    this.draft.description = v;
                }, 7)),
                createField('性格特征 (personality)', createTextArea(d.personality ?? this.draft.personality, v => {
                    d.personality = v;
                    this.draft.personality = v;
                }, 3)),
                createField('场景设定 (scenario)', createTextArea(d.scenario ?? this.draft.scenario, v => {
                    d.scenario = v;
                    this.draft.scenario = v;
                }, 3))
            );
            return wrap;
        }

        if (this.activePage === 'greetings') {
            if (!Array.isArray(d.alternate_greetings)) d.alternate_greetings = [];
            wrap.append(
                createField('主开场白 (first_mes)', createTextArea(d.first_mes ?? this.draft.first_mes, v => {
                    d.first_mes = v;
                    this.draft.first_mes = v;
                }, 7))
            );

            const altSec = createEl('div', 'trh-sub-list-box');
            const altHead = createEl('div', 'trh-sub-list-head');
            altHead.append(createEl('span', 'trh-field-label', `候选开场白 (${d.alternate_greetings.length})`));
            const addAltBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-subtle', '+ 新增候选开场白');
            addAltBtn.type = 'button';
            addAltBtn.addEventListener('click', () => {
                d.alternate_greetings.push('');
                this.render();
            });
            altHead.append(addAltBtn);
            altSec.append(altHead);

            if (d.alternate_greetings.length === 0) {
                altSec.append(createEl('div', 'trh-text-muted', '暂无候选开场白，可点击右上角新增。'));
            } else {
                d.alternate_greetings.forEach((greeting, idx) => {
                    const row = createEl('div', 'trh-alt-greeting-row');
                    const ta = createTextArea(greeting, v => {
                        d.alternate_greetings[idx] = v;
                    }, 3);
                    const delBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-danger', '删除');
                    delBtn.type = 'button';
                    delBtn.addEventListener('click', () => {
                        d.alternate_greetings.splice(idx, 1);
                        this.render();
                    });
                    row.append(ta, delBtn);
                    altSec.append(row);
                });
            }
            wrap.append(altSec);
            return wrap;
        }

        // 'prompts'
        wrap.append(
            createField('角色系统提示词 (system_prompt)', createTextArea(d.system_prompt, v => {
                d.system_prompt = v;
            }, 4)),
            createField('历史后指令 (post_history_instructions)', createTextArea(d.post_history_instructions, v => {
                d.post_history_instructions = v;
            }, 4)),
            createField('对话示例 (mes_example)', createTextArea(d.mes_example ?? this.draft.mes_example, v => {
                d.mes_example = v;
                this.draft.mes_example = v;
            }, 5)),
            createField('作者注释 (creator_notes)', createTextArea(d.creator_notes ?? this.draft.creatorcomment, v => {
                d.creator_notes = v;
                this.draft.creatorcomment = v;
            }, 4))
        );
        return wrap;
    }

    // =========================================================================
    // 预设分页
    // =========================================================================

    _renderPresetPage() {
        const wrap = createEl('div', 'trh-form-stack');
        if (!Array.isArray(this.draft.prompts)) this.draft.prompts = [];
        const prompts = this.draft.prompts;
        if (this.selectedPromptIdx >= prompts.length) {
            this.selectedPromptIdx = Math.max(0, prompts.length - 1);
        }

        if (this.activePage === 'params') {
            const paramsGrid = createEl('div', 'trh-form-grid-2');
            paramsGrid.append(
                createField('Temperature', createNumberInput(
                    this.draft.temperature ?? this.draft.settings?.temperature,
                    v => {
                        if (this.draft.settings) this.draft.settings.temperature = v;
                        else this.draft.temperature = v;
                    },
                    '0.01'
                )),
                createField('Top P', createNumberInput(
                    this.draft.top_p ?? this.draft.settings?.top_p,
                    v => {
                        if (this.draft.settings) this.draft.settings.top_p = v;
                        else this.draft.top_p = v;
                    },
                    '0.01'
                )),
                createField('最大上下文 (Context)', createNumberInput(
                    this.draft.openai_max_context ?? this.draft.max_context ?? this.draft.settings?.max_context,
                    v => {
                        if (this.draft.settings) this.draft.settings.max_context = v;
                        else if ('max_context' in this.draft) this.draft.max_context = v;
                        else this.draft.openai_max_context = v;
                    },
                    '1'
                )),
                createField('最大回复 (Max Tokens)', createNumberInput(
                    this.draft.openai_max_tokens ?? this.draft.max_completion_tokens ?? this.draft.settings?.max_completion_tokens,
                    v => {
                        if (this.draft.settings) this.draft.settings.max_completion_tokens = v;
                        else if ('max_completion_tokens' in this.draft) this.draft.max_completion_tokens = v;
                        else this.draft.openai_max_tokens = v;
                    },
                    '1'
                )),
                createField('Frequency Penalty', createNumberInput(
                    this.draft.frequency_penalty ?? this.draft.settings?.frequency_penalty,
                    v => {
                        if (this.draft.settings) this.draft.settings.frequency_penalty = v;
                        else this.draft.frequency_penalty = v;
                    },
                    '0.01'
                )),
                createField('Presence Penalty', createNumberInput(
                    this.draft.presence_penalty ?? this.draft.settings?.presence_penalty,
                    v => {
                        if (this.draft.settings) this.draft.settings.presence_penalty = v;
                        else this.draft.presence_penalty = v;
                    },
                    '0.01'
                ))
            );
            wrap.append(paramsGrid);
            return wrap;
        }

        if (this.activePage === 'list') {
            const listBox = createEl('div', 'trh-sub-list-box');
            const listHead = createEl('div', 'trh-sub-list-head');
            listHead.append(createEl('span', 'trh-field-label', `提示词条目 (${prompts.length}) · 点击条目进入编辑`));
            const addBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-subtle', '+ 新增条目');
            addBtn.type = 'button';
            addBtn.addEventListener('click', () => {
                prompts.push({
                    identifier: `custom_${Date.now()}`,
                    name: '新提示词条目',
                    role: 'system',
                    content: '',
                    enabled: true,
                });
                this.selectedPromptIdx = prompts.length - 1;
                this._switchPage('item');
            });
            listHead.append(addBtn);

            const itemsBox = createEl('div', 'trh-editor-page-list');
            prompts.forEach((p, idx) => {
                const itemRow = createEl('div', `trh-editor-item ${idx === this.selectedPromptIdx ? 'is-active' : ''}`);
                const toggle = createEl('input');
                toggle.type = 'checkbox';
                toggle.checked = p.enabled !== false;
                toggle.title = '启用/禁用该提示词条目';
                toggle.addEventListener('click', (e) => e.stopPropagation());
                toggle.addEventListener('change', () => {
                    p.enabled = toggle.checked;
                });

                const nameSpan = createEl('span', 'trh-editor-item-name', p.name || p.identifier || `条目 #${idx + 1}`);
                const roleTag = createEl('span', 'trh-mono-tag', p.role || 'system');
                const arrow = createIcon('fa-chevron-right');
                arrow.classList.add('trh-text-muted');
                itemRow.append(toggle, nameSpan, roleTag, arrow);
                itemRow.addEventListener('click', () => {
                    this.selectedPromptIdx = idx;
                    this._switchPage('item');
                });
                itemsBox.append(itemRow);
            });

            listBox.append(listHead, itemsBox);
            wrap.append(listBox);
            return wrap;
        }

        // 'item'
        const current = prompts[this.selectedPromptIdx];
        if (!current) {
            wrap.append(createEl('div', 'trh-inspector-empty', '暂无提示词条目，请切换至「提示词列表」页新增。'));
            return wrap;
        }

        const itemSelector = createEl('select', 'trh-select');
        prompts.forEach((p, idx) => {
            const opt = createEl('option', '', `${idx + 1}. ${p.name || p.identifier || '未命名'} (${p.role || 'system'})`);
            opt.value = String(idx);
            if (idx === this.selectedPromptIdx) opt.selected = true;
            itemSelector.append(opt);
        });
        itemSelector.addEventListener('change', () => {
            this.selectedPromptIdx = Number(itemSelector.value);
            this.render({ resetScroll: true });
        });

        const topMeta = createEl('div', 'trh-form-grid-2');
        const roleSel = createEl('select', 'trh-select');
        for (const role of ['system', 'user', 'assistant']) {
            const opt = createEl('option', '', role);
            opt.value = role;
            if ((current.role || 'system') === role) opt.selected = true;
            roleSel.append(opt);
        }
        roleSel.addEventListener('change', () => {
            current.role = roleSel.value;
        });

        topMeta.append(
            createField('条目名称 (name)', createTextInput(current.name, v => {
                current.name = v;
            })),
            createField('消息角色 (role)', roleSel)
        );

        const toggleRow = createEl('label', 'trh-checkbox-row');
        const enabledCb = createEl('input');
        enabledCb.type = 'checkbox';
        enabledCb.checked = current.enabled !== false;
        enabledCb.addEventListener('change', () => {
            current.enabled = enabledCb.checked;
        });
        toggleRow.append(enabledCb, createEl('span', '', '启用该提示词条目'));

        const contentArea = createTextArea(current.content, v => {
            current.content = v;
        }, 12, '输入提示词正文内容...');

        const delRow = createEl('div', 'trh-btn-row trh-btn-row-end');
        const delPromptBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-danger', '删除此条目');
        delPromptBtn.type = 'button';
        delPromptBtn.addEventListener('click', () => {
            prompts.splice(this.selectedPromptIdx, 1);
            this.selectedPromptIdx = Math.max(0, this.selectedPromptIdx - 1);
            this._switchPage('list');
        });
        delRow.append(delPromptBtn);

        wrap.append(
            createField('当前编辑条目', itemSelector),
            toggleRow,
            topMeta,
            createField('提示词正文 (content)', contentArea),
            delRow
        );
        return wrap;
    }

    // =========================================================================
    // 世界书分页
    // =========================================================================

    _renderWorldbookPage() {
        const wrap = createEl('div', 'trh-form-stack');
        if (!this.draft.entries || typeof this.draft.entries !== 'object') {
            this.draft.entries = {};
        }
        const entries = this.draft.entries;
        const keys = Object.keys(entries);
        if (!this.selectedWorldKey || !entries[this.selectedWorldKey]) {
            this.selectedWorldKey = keys[0] || null;
        }

        if (this.activePage === 'list') {
            const listBox = createEl('div', 'trh-sub-list-box');
            const listHead = createEl('div', 'trh-sub-list-head');
            listHead.append(createEl('span', 'trh-field-label', `词条列表 (${keys.length}) · 点击词条编辑`));
            const addBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-subtle', '+ 新增词条');
            addBtn.type = 'button';
            addBtn.addEventListener('click', () => {
                const nextUid = keys.reduce((max, k) => Math.max(max, Number(entries[k]?.uid ?? k) || 0), -1) + 1;
                const nextKey = String(nextUid);
                entries[nextKey] = {
                    uid: nextUid,
                    key: [],
                    keysecondary: [],
                    comment: `新词条 #${nextUid}`,
                    content: '',
                    constant: false,
                    selective: true,
                    order: 100,
                    position: 0,
                    depth: 4,
                    disable: false,
                };
                this.selectedWorldKey = nextKey;
                this._switchPage('item');
            });
            listHead.append(addBtn);

            const searchInput = createTextInput(this.entrySearch, v => {
                this.entrySearch = v;
                this._renderWorldbookItems(itemsBox, entries);
            }, '按关键词或标题筛选词条...');

            const itemsBox = createEl('div', 'trh-editor-page-list');
            this._renderWorldbookItems(itemsBox, entries);

            listBox.append(listHead, searchInput, itemsBox);
            wrap.append(listBox);
            return wrap;
        }

        // 'item'
        const entry = this.selectedWorldKey ? entries[this.selectedWorldKey] : null;
        if (!entry) {
            wrap.append(createEl('div', 'trh-inspector-empty', '暂无词条，请切换至「词条列表」页新增。'));
            return wrap;
        }

        const entrySelector = createEl('select', 'trh-select');
        for (const k of keys) {
            const item = entries[k];
            if (!item) continue;
            const opt = createEl('option', '', item.comment || (item.key || []).join(', ') || `词条 #${k}`);
            opt.value = k;
            if (k === this.selectedWorldKey) opt.selected = true;
            entrySelector.append(opt);
        }
        entrySelector.addEventListener('change', () => {
            this.selectedWorldKey = entrySelector.value;
            this.render({ resetScroll: true });
        });

        const enabledRow = createEl('label', 'trh-checkbox-row');
        const enabledCb = createEl('input');
        enabledCb.type = 'checkbox';
        enabledCb.checked = !entry.disable;
        enabledCb.addEventListener('change', () => {
            entry.disable = !enabledCb.checked;
        });
        enabledRow.append(enabledCb, createEl('span', '', '启用该世界书词条'));

        const row1 = createEl('div', 'trh-form-grid-2');
        row1.append(
            createField('词条标题 / 注释 (comment)', createTextInput(entry.comment, v => {
                entry.comment = v;
            })),
            createField('主要触发关键词 (英文逗号分隔)', createTextInput(
                Array.isArray(entry.key) ? entry.key.join(', ') : '',
                v => {
                    entry.key = v.split(',').map(s => s.trim()).filter(Boolean);
                }
            ))
        );

        const row2 = createEl('div', 'trh-form-grid-2');
        const modeSel = createEl('select', 'trh-select');
        for (const optDef of [
            { val: 'selective', text: '绿灯 (关键词触发)' },
            { val: 'constant', text: '蓝灯 (常量始终激活)' },
        ]) {
            const opt = createEl('option', '', optDef.text);
            opt.value = optDef.val;
            if ((entry.constant ? 'constant' : 'selective') === optDef.val) opt.selected = true;
            modeSel.append(opt);
        }
        modeSel.addEventListener('change', () => {
            entry.constant = modeSel.value === 'constant';
            entry.selective = !entry.constant;
        });

        const posSel = createEl('select', 'trh-select');
        for (const posDef of [
            { val: 0, text: '角色定义之前' },
            { val: 1, text: '角色定义之后' },
            { val: 4, text: '按深度插入 (@D)' },
            { val: 2, text: '作者注释之前' },
            { val: 3, text: '作者注释之后' },
        ]) {
            const opt = createEl('option', '', posDef.text);
            opt.value = String(posDef.val);
            if (Number(entry.position ?? 0) === posDef.val) opt.selected = true;
            posSel.append(opt);
        }
        posSel.addEventListener('change', () => {
            entry.position = Number(posSel.value);
        });

        row2.append(
            createField('激活策略', modeSel),
            createField('插入位置', posSel),
            createField('插入顺序 (order)', createNumberInput(entry.order ?? 100, v => {
                entry.order = v ?? 100;
            }, '1')),
            createField('插入深度 (depth)', createNumberInput(entry.depth ?? 4, v => {
                entry.depth = v ?? 4;
            }, '1'))
        );

        const contentArea = createTextArea(entry.content, v => {
            entry.content = v;
        }, 10, '输入世界书词条正文内容...');

        const delRow = createEl('div', 'trh-btn-row trh-btn-row-end');
        const delEntryBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-danger', '删除此词条');
        delEntryBtn.type = 'button';
        delEntryBtn.addEventListener('click', () => {
            delete entries[this.selectedWorldKey];
            this.selectedWorldKey = Object.keys(entries)[0] || null;
            this._switchPage('list');
        });
        delRow.append(delEntryBtn);

        wrap.append(
            createField('当前编辑词条', entrySelector),
            enabledRow,
            row1,
            row2,
            createField('词条正文 (content)', contentArea),
            delRow
        );
        return wrap;
    }

    _renderWorldbookItems(container, entries) {
        container.replaceChildren();
        const q = this.entrySearch.trim().toLowerCase();
        for (const [k, entry] of Object.entries(entries)) {
            if (!entry) continue;
            const hay = `${entry.comment || ''} ${(entry.key || []).join(' ')}`.toLowerCase();
            if (q && !hay.includes(q)) continue;

            const itemRow = createEl('div', `trh-editor-item ${k === this.selectedWorldKey ? 'is-active' : ''}`);
            const toggle = createEl('input');
            toggle.type = 'checkbox';
            toggle.checked = !entry.disable;
            toggle.title = '启用/禁用该词条';
            toggle.addEventListener('click', (e) => e.stopPropagation());
            toggle.addEventListener('change', () => {
                entry.disable = !toggle.checked;
            });

            const lamp = createEl('span', `trh-wb-lamp ${entry.constant ? 'is-blue' : 'is-green'}`);
            const label = entry.comment || (entry.key || []).join(', ') || `词条 #${k}`;
            const nameSpan = createEl('span', 'trh-editor-item-name', label);
            const arrow = createIcon('fa-chevron-right');
            arrow.classList.add('trh-text-muted');
            itemRow.append(toggle, lamp, nameSpan, arrow);

            itemRow.addEventListener('click', () => {
                this.selectedWorldKey = k;
                this._switchPage('item');
            });
            container.append(itemRow);
        }
    }
}
