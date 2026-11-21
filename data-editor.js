/**
 * Tavern-Resource-Hub: Internal Data Viewer & Editor Modal
 * 支持可视化结构化编辑与原始 JSON 源码编辑：
 * - 角色卡：设定、主/候选开场白、系统提示词、示例对话、作者注释、标签
 * - 预设：采样参数、提示词条目列表（开关/角色/内容/增删）
 * - 世界书：词条列表（启用开关/蓝绿灯/关键词/深度顺序/正文/增删）
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
    /**
     * @param {Object} options
     * @param {Function} options.getContext
     * @param {import('./binding-store.js').BindingStore} options.store
     * @param {Function} [options.fetchImpl]
     * @param {Function} [options.onNotify]
     * @param {Function} [options.onSaved]
     */
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
        this.mode = 'form'; // 'form' | 'json'
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

    async open({ type, id, name, parentEl }) {
        const context = this.getContext?.();
        let rawData;
        if (type === 'character') {
            const full = await PlatformAdapter.getCharacterFullData(context, id);
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
        this.mode = 'form';
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

    async save() {
        if (this.mode === 'json' && !this._syncFromJsonText()) {
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

    render() {
        if (!this.backdrop || !this.isOpen) return;
        this.backdrop.replaceChildren();

        const modal = createEl('div', 'trh-editor-modal');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        // 1. 顶部栏
        const header = createEl('div', 'trh-editor-header');
        const titleWrap = createEl('div', 'trh-editor-title-wrap');
        const typeLabel = { character: '角色卡数据', preset: '预设数据', worldbook: '世界书词条' }[this.type] || '内部数据';
        titleWrap.append(
            createEl('span', 'trh-badge trh-badge-slate', typeLabel),
            createEl('h2', 'trh-editor-title', this.title)
        );

        const modeTabs = createEl('div', 'trh-editor-mode-tabs');
        const formTabBtn = createEl('button', `trh-mode-btn ${this.mode === 'form' ? 'is-active' : ''}`, '可视化编辑');
        formTabBtn.type = 'button';
        formTabBtn.addEventListener('click', () => {
            if (this.mode === 'json' && !this._syncFromJsonText()) {
                this.render();
                return;
            }
            this.mode = 'form';
            this.render();
        });

        const jsonTabBtn = createEl('button', `trh-mode-btn ${this.mode === 'json' ? 'is-active' : ''}`, '原始 JSON');
        jsonTabBtn.type = 'button';
        jsonTabBtn.addEventListener('click', () => {
            this.jsonText = JSON.stringify(this.draft, null, 2);
            this.jsonError = '';
            this.mode = 'json';
            this.render();
        });
        modeTabs.append(formTabBtn, jsonTabBtn);

        const closeBtn = createEl('button', 'trh-btn trh-btn-icon');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', '关闭编辑器');
        closeBtn.append(createIcon('fa-xmark'));
        closeBtn.addEventListener('click', () => this.close());

        header.append(titleWrap, modeTabs, closeBtn);

        // 2. 主体内容
        const body = createEl('div', 'trh-editor-body');
        if (this.mode === 'json') {
            body.append(this._renderJsonEditor());
        } else if (this.type === 'character') {
            body.append(this._renderCharacterForm());
        } else if (this.type === 'preset') {
            body.append(this._renderPresetForm());
        } else if (this.type === 'worldbook') {
            body.append(this._renderWorldbookForm());
        }

        // 3. 底部操作栏
        const footer = createEl('div', 'trh-editor-footer');
        const hint = createEl('span', 'trh-mono-sub', '保存前会自动备份当前版本快照，支持一键回滚');
        const btnGroup = createEl('div', 'trh-btn-row trh-btn-row-end');
        const cancelBtn = createEl('button', 'trh-btn trh-btn-ghost', '取消');
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', () => this.close());

        const saveBtn = createEl('button', 'trh-btn trh-btn-accent', this.isSaving ? '保存中...' : '保存修改');
        saveBtn.type = 'button';
        saveBtn.id = 'trh_editor_save_btn';
        saveBtn.disabled = this.isSaving;
        saveBtn.addEventListener('click', () => this.save());

        btnGroup.append(cancelBtn, saveBtn);
        footer.append(hint, btnGroup);

        modal.append(header, body, footer);
        this.backdrop.append(modal);
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

    _renderCharacterForm() {
        const d = this.draft.data || (this.draft.data = {});
        const wrap = createEl('div', 'trh-form-stack');

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
        wrap.append(grid);

        wrap.append(
            createField('角色描述 (description)', createTextArea(d.description ?? this.draft.description, v => {
                d.description = v;
                this.draft.description = v;
            }, 6)),
            createField('性格特征 (personality)', createTextArea(d.personality ?? this.draft.personality, v => {
                d.personality = v;
                this.draft.personality = v;
            }, 3)),
            createField('场景设定 (scenario)', createTextArea(d.scenario ?? this.draft.scenario, v => {
                d.scenario = v;
                this.draft.scenario = v;
            }, 3)),
            createField('主开场白 (first_mes)', createTextArea(d.first_mes ?? this.draft.first_mes, v => {
                d.first_mes = v;
                this.draft.first_mes = v;
            }, 5))
        );

        // 候选开场白
        if (!Array.isArray(d.alternate_greetings)) d.alternate_greetings = [];
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

        d.alternate_greetings.forEach((greeting, idx) => {
            const row = createEl('div', 'trh-alt-greeting-row');
            const ta = createTextArea(greeting, v => {
                d.alternate_greetings[idx] = v;
            }, 2);
            const delBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-danger', '删除');
            delBtn.type = 'button';
            delBtn.addEventListener('click', () => {
                d.alternate_greetings.splice(idx, 1);
                this.render();
            });
            row.append(ta, delBtn);
            altSec.append(row);
        });
        wrap.append(altSec);

        wrap.append(
            createField('角色系统提示词 (system_prompt)', createTextArea(d.system_prompt, v => {
                d.system_prompt = v;
            }, 3)),
            createField('历史后指令 (post_history_instructions)', createTextArea(d.post_history_instructions, v => {
                d.post_history_instructions = v;
            }, 3)),
            createField('对话示例 (mes_example)', createTextArea(d.mes_example ?? this.draft.mes_example, v => {
                d.mes_example = v;
                this.draft.mes_example = v;
            }, 4)),
            createField('作者注释 (creator_notes)', createTextArea(d.creator_notes ?? this.draft.creatorcomment, v => {
                d.creator_notes = v;
                this.draft.creatorcomment = v;
            }, 3))
        );

        return wrap;
    }

    _renderPresetForm() {
        const wrap = createEl('div', 'trh-form-stack');

        // 1. 采样参数区
        const paramsGrid = createEl('div', 'trh-form-grid-4');
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
            ))
        );
        wrap.append(paramsGrid);

        // 2. 提示词条目分栏编辑器
        if (!Array.isArray(this.draft.prompts)) this.draft.prompts = [];
        const prompts = this.draft.prompts;
        if (this.selectedPromptIdx >= prompts.length) {
            this.selectedPromptIdx = Math.max(0, prompts.length - 1);
        }

        const split = createEl('div', 'trh-editor-split');

        // 左侧条目列表
        const listCol = createEl('div', 'trh-editor-list-col');
        const listHead = createEl('div', 'trh-sub-list-head');
        listHead.append(createEl('span', 'trh-field-label', `提示词条目 (${prompts.length})`));
        const addBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-subtle', '+ 新增');
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
            this.render();
        });
        listHead.append(addBtn);
        listCol.append(listHead);

        const itemsBox = createEl('div', 'trh-editor-items');
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
            itemRow.append(toggle, nameSpan, roleTag);
            itemRow.addEventListener('click', () => {
                this.selectedPromptIdx = idx;
                this.render();
            });
            itemsBox.append(itemRow);
        });
        listCol.append(itemsBox);

        // 右侧选中条目编辑区
        const detailCol = createEl('div', 'trh-editor-detail-col');
        const current = prompts[this.selectedPromptIdx];
        if (!current) {
            detailCol.append(createEl('div', 'trh-inspector-empty', '暂无提示词条目，可点击左侧「+ 新增」添加。'));
        } else {
            const topMeta = createEl('div', 'trh-form-grid-2');
            topMeta.append(
                createField('条目名称 (name)', createTextInput(current.name, v => {
                    current.name = v;
                    const activeEl = itemsBox.children[this.selectedPromptIdx]?.querySelector('.trh-editor-item-name');
                    if (activeEl) activeEl.textContent = v || current.identifier || '未命名';
                })),
                (() => {
                    const sel = createEl('select', 'trh-select');
                    for (const role of ['system', 'user', 'assistant']) {
                        const opt = createEl('option', '', role);
                        opt.value = role;
                        if ((current.role || 'system') === role) opt.selected = true;
                        sel.append(opt);
                    }
                    sel.addEventListener('change', () => {
                        current.role = sel.value;
                        this.render();
                    });
                    return createField('消息角色 (role)', sel);
                })()
            );

            const contentArea = createTextArea(current.content, v => {
                current.content = v;
            }, 12, '输入提示词正文内容...');

            const delRow = createEl('div', 'trh-btn-row trh-btn-row-end');
            const delPromptBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-danger', '删除此条目');
            delPromptBtn.type = 'button';
            delPromptBtn.addEventListener('click', () => {
                prompts.splice(this.selectedPromptIdx, 1);
                this.selectedPromptIdx = Math.max(0, this.selectedPromptIdx - 1);
                this.render();
            });
            delRow.append(delPromptBtn);

            detailCol.append(topMeta, createField('提示词正文 (content)', contentArea), delRow);
        }

        split.append(listCol, detailCol);
        wrap.append(split);
        return wrap;
    }

    _renderWorldbookForm() {
        if (!this.draft.entries || typeof this.draft.entries !== 'object') {
            this.draft.entries = {};
        }
        const entries = this.draft.entries;
        const keys = Object.keys(entries);
        if (!this.selectedWorldKey || !entries[this.selectedWorldKey]) {
            this.selectedWorldKey = keys[0] || null;
        }

        const split = createEl('div', 'trh-editor-split');

        // 左侧词条列表
        const listCol = createEl('div', 'trh-editor-list-col');
        const listHead = createEl('div', 'trh-sub-list-head');
        listHead.append(createEl('span', 'trh-field-label', `词条列表 (${keys.length})`));
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
            this.render();
        });
        listHead.append(addBtn);

        const searchInput = createTextInput(this.entrySearch, v => {
            this.entrySearch = v;
            this._renderWorldbookItems(itemsBox, entries);
        }, '按关键词或标题筛选词条...');
        searchInput.classList.add('trh-editor-mini-search');

        const itemsBox = createEl('div', 'trh-editor-items');
        this._renderWorldbookItems(itemsBox, entries);

        listCol.append(listHead, searchInput, itemsBox);

        // 右侧词条详细编辑区
        const detailCol = createEl('div', 'trh-editor-detail-col');
        const entry = this.selectedWorldKey ? entries[this.selectedWorldKey] : null;
        if (!entry) {
            detailCol.append(createEl('div', 'trh-inspector-empty', '暂无词条，可点击左侧「+ 新增词条」添加。'));
        } else {
            const row1 = createEl('div', 'trh-form-grid-2');
            row1.append(
                createField('词条标题 / 注释 (comment)', createTextInput(entry.comment, v => {
                    entry.comment = v;
                    this._renderWorldbookItems(itemsBox, entries);
                })),
                createField('主要触发关键词 (英文逗号分隔)', createTextInput(
                    Array.isArray(entry.key) ? entry.key.join(', ') : '',
                    v => {
                        entry.key = v.split(',').map(s => s.trim()).filter(Boolean);
                    }
                ))
            );

            const row2 = createEl('div', 'trh-form-grid-4');
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
                this._renderWorldbookItems(itemsBox, entries);
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
            }, 11, '输入世界书词条正文内容...');

            const delRow = createEl('div', 'trh-btn-row trh-btn-row-end');
            const delEntryBtn = createEl('button', 'trh-btn trh-btn-xs trh-btn-danger', '删除此词条');
            delEntryBtn.type = 'button';
            delEntryBtn.addEventListener('click', () => {
                delete entries[this.selectedWorldKey];
                this.selectedWorldKey = Object.keys(entries)[0] || null;
                this.render();
            });
            delRow.append(delEntryBtn);

            detailCol.append(row1, row2, createField('词条正文 (content)', contentArea), delRow);
        }

        split.append(listCol, detailCol);
        return split;
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
            itemRow.append(toggle, lamp, nameSpan);

            itemRow.addEventListener('click', () => {
                this.selectedWorldKey = k;
                this.render();
            });
            container.append(itemRow);
        }
    }
}
